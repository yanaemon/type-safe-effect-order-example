// =============================================================================
// ts-checked-fsm — FSM 定義 そのもの を compile-time で検証する
// =============================================================================
//
// tableau/ts-checked-fsm は xstate や typestate と同じ「状態機械」だが、
// 立ち位置は compile-time 側。本編 03 の Type-State Pattern と同じレイヤーで、
// 「FSM の構造的な整合性」を TS の型システムで検証する builder ライブラリ。
//
// コンパイル時に弾けるもの (= ライブラリの核):
//   - 宣言していない state への transition
//   - 同じ state を 2 度宣言
//   - 同じ (state, action) ペアのハンドラを 2 度宣言
//   - 存在しない state/action へのハンドラ
//   - ハンドラが「宣言されていない遷移先 state」を返す
//   - 非終端 state にハンドラを書き忘れる
//
// 一方で、runtime の挙動は xstate に近い:
//   - 現在の state がそのアクションを受け付けない → state は変わらない (no-op)
//
// つまり ts-checked-fsm は「FSM の定義の正しさ」を compile-time に保証し、
// 「定義に従った dispatch」は runtime に任せる ハイブリッド。
// =============================================================================

// ts-checked-fsm は CJS のみで Node の ESM 名前付き export 検出が効かないため
// default import 経由で取り出す (型は付いてくる)
import tsCheckedFsm from "ts-checked-fsm";

const { stateMachine } = tsCheckedFsm;

type UserData = {
    name: string;
    age: number;
};

// -----------------------------------------------------------------------------
// FSM の宣言: builder の各 step で型が進む
//   .state(...) → .transition(...) → .action(...) → .actionHandler(...) → .done()
// 並び順が崩れると、その時点で型エラーになる (= API レベルで builder pattern を強制)
// -----------------------------------------------------------------------------

const { nextState } = stateMachine()
    .state("draft")
    .state("validated")
    .state("invalid")
    .state("saved")
    .state("notified")
    // 宣言されていない state を書くと .done() でコンパイルエラーになる
    .transition("draft", "validated")
    .transition("draft", "invalid")
    .transition("validated", "saved")
    .transition("saved", "notified")
    .action<"VALIDATE", { input: UserData }>("VALIDATE")
    .action("SAVE")
    .action("NOTIFY")
    // ハンドラの戻り値が「宣言された遷移先 state」でないとコンパイルエラー
    .actionHandler("draft", "VALIDATE", (_state, action) => {
        console.log("[validate]", action.input.name);
        if (action.input.name.length === 0 || action.input.age < 0) {
            return { stateName: "invalid" } as const;
        }
        return { stateName: "validated" } as const;
    })
    .actionHandler("validated", "SAVE", (_state, _action) => ({ stateName: "saved" }) as const)
    .actionHandler("saved", "NOTIFY", (_state, _action) => ({ stateName: "notified" }) as const)
    .done();

// -----------------------------------------------------------------------------
// 副作用 (async) は FSM の外で実行し、終わったら nextState で状態を進める
// -----------------------------------------------------------------------------

async function save(input: UserData): Promise<void> {
    console.log("[save]   ", input.name);
}

async function notify(input: UserData): Promise<void> {
    console.log("[notify] ", input.name);
}

// -----------------------------------------------------------------------------
// ✅ 正しい順序
// -----------------------------------------------------------------------------

console.log("--- happy path ---");

{
    const input: UserData = { name: "test", age: 30 };
    let state = nextState({ stateName: "draft" } as const, {
        actionName: "VALIDATE",
        input,
    });
    console.log("after VALIDATE:", state.stateName);

    if (state.stateName === "validated") {
        await save(input);
        state = nextState(state, { actionName: "SAVE" });
        console.log("after SAVE    :", state.stateName);

        if (state.stateName === "saved") {
            await notify(input);
            state = nextState(state, { actionName: "NOTIFY" });
            console.log("after NOTIFY  :", state.stateName);
        }
    }
}

// -----------------------------------------------------------------------------
// ✋ validate に失敗 → invalid に遷移してそこで終わり
// -----------------------------------------------------------------------------

console.log("--- guard failure ---");

{
    const bad: UserData = { name: "", age: 30 };
    const state = nextState({ stateName: "draft" } as const, {
        actionName: "VALIDATE",
        input: bad,
    });
    console.log("[exit]   ", state.stateName); // "invalid"
}

// -----------------------------------------------------------------------------
// 🚨 不正な順序: 現在 state がそのアクションを持たない → no-op (xstate 流)
// -----------------------------------------------------------------------------

console.log("--- wrong action silently no-op ---");

{
    // draft 状態で SAVE は宣言されていない → state は変わらない (型レベルでは弾かない)
    const state = nextState({ stateName: "draft" } as const, {
        actionName: "SAVE",
    });
    console.log("[state]  ", state.stateName); // "draft" のまま
}

// -----------------------------------------------------------------------------
// 🛡 ライブラリの核: FSM 定義そのものへの compile-time チェック
// -----------------------------------------------------------------------------
// 下の builder は実行しない (型チェック用)。@ts-expect-error がついた行が
// 「ライブラリが弾いてくれるはずの構造ミス」。
//
// ※ ts-checked-fsm は意図的に「人間が読めるエラー文字列」を branded type で
//    返してくる。ホバーすると `ErrorBrand<"'foo' is not a state">` のような
//    メッセージが見える。

function _typeOnlyExamples() {
    // ケース 1: 宣言していない state への transition
    void stateMachine()
        .state("draft")
        .state("validated")
        // @ts-expect-error  "saved" は宣言していない → transition できない
        .transition("draft", "saved");

    // ケース 2: 同じ state を 2 度宣言
    void stateMachine()
        .state("draft")
        // @ts-expect-error  "draft" は既に宣言済み
        .state("draft");

    // ケース 3: ハンドラが遷移宣言と矛盾する state を返す
    void stateMachine()
        .state("draft")
        .state("validated")
        .transition("draft", "validated")
        .action("VALIDATE")
        .actionHandler(
            "draft",
            "VALIDATE",
            // @ts-expect-error  "draft" -> "saved" の transition は宣言されていない
            (_s, _a) => ({ stateName: "saved" }) as const,
        );
}
void _typeOnlyExamples;

// -----------------------------------------------------------------------------
// 結論:
//   - ts-checked-fsm は「FSM の定義の正しさ」を compile-time に検証する
//     → Type-State Pattern (本編 03) と同じレイヤーの仕事を library 化したもの
//   - runtime の挙動 (dispatch) は xstate と同じく no-op フォールバック
//   - xstate より遥かに軽量だが、parallel / hierarchical / actor は無い
//   - 「状態と遷移をデータとして書きたい」かつ「定義の整合性を型で守りたい」
//     場合に fit
// -----------------------------------------------------------------------------
