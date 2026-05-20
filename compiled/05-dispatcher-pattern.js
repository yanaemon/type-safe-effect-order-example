// =============================================================================
// 05. Dispatcher Pattern — 値ベース FSM に型を載せられるか？
// =============================================================================
//
// 03 / 04 (type-state) は「状態を class / 型に閉じ込めて、メソッド呼び出し =
// 遷移」だった。dispatcher はその逆: 状態は値、遷移は dispatch(state, event)
// 関数。runtime の汎用 FSM ライブラリがやっていることの最小版。
//
// 結論を先に: dispatch ロジック自体は runtime コードでしか書けないが、
// 遷移表を「型の値」として持てば、呼び出し側に compile-time の順序制約は
// 乗せられる (= ts-checked-fsm 系の中身)。ただし state が runtime ソース
// (DB / queue / `let s: State`) を経由した瞬間に kind が union 化して効か
// なくなる、という限界もある。
//
// このファイルでは 2 段階で示す:
//   (A) 素朴な値ベース FSM   — 不正遷移は runtime で no-op (型では止められない)
//   (B) 遷移表を型に持つ版   — 不正遷移を compile-time に止める
// =============================================================================
function dispatch(state, event) {
    switch (state) {
        case "draft":
            if (event === "VALIDATE") {
                return "validated";
            }
            return state;
        case "validated":
            if (event === "SAVE") {
                return "saved";
            }
            return state;
        case "saved":
            if (event === "NOTIFY") {
                return state; // 自己ループ
            }
            return state;
    }
}
{
    let s = "draft";
    s = dispatch(s, "VALIDATE"); // validated
    s = dispatch(s, "NOTIFY"); // ❌ saved 前に NOTIFY — runtime で no-op、validated のまま
    s = dispatch(s, "SAVE"); // saved
    s = dispatch(s, "NOTIFY"); // saved (適切な順序)
    console.log("[A] final =", s);
}
async function dispatchTyped(state, event) {
    // 外向きシグネチャが安全網。実装は plain な switch で十分なので、
    // 内部 helper に投げて結果を `as never` で型に押し込む。
    return _dispatchTyped(state, event);
}
async function _dispatchTyped(state, event) {
    if (state.kind === "draft" && event.type === "VALIDATE") {
        console.log("[validate]", state.data.name);
        if (state.data.name.length === 0 || state.data.age < 0) {
            throw new Error("validation failed");
        }
        return { kind: "validated", data: state.data };
    }
    if (state.kind === "validated" && event.type === "SAVE") {
        console.log("[save]   ", state.data.name);
        return { kind: "saved", data: state.data };
    }
    if (state.kind === "saved" && event.type === "NOTIFY") {
        console.log("[notify] ", state.data.name);
        return state;
    }
    // 型システム上は到達不能だが、runtime の保険として残しておく
    throw new Error(`invalid transition: ${state.kind} + ${event.type}`);
}
// ✅ 各 await の戻りが narrow な TypedState<...> として絞られる
const s0 = {
    kind: "draft",
    data: { name: "test", age: 30 },
};
const s1 = await dispatchTyped(s0, { type: "VALIDATE" }); // TypedState<"validated">
const s2 = await dispatchTyped(s1, { type: "SAVE" }); // TypedState<"saved">
const s3 = await dispatchTyped(s2, { type: "NOTIFY" }); // TypedState<"saved">
void s3;
// ❌ 順序ミスは compile-time に止まる
async function _typeOnlyExamples() {
    // @ts-expect-error  draft では NOTIFY を受理しない
    await dispatchTyped(s0, { type: "NOTIFY" });
    // @ts-expect-error  draft では SAVE を受理しない
    await dispatchTyped(s0, { type: "SAVE" });
    // @ts-expect-error  saved では VALIDATE を受理しない
    await dispatchTyped(s2, { type: "VALIDATE" });
}
void _typeOnlyExamples;
export {};
// -----------------------------------------------------------------------------
// (B) の限界
// -----------------------------------------------------------------------------
//
//   let s: TypedState = loadFromDatabase();          // ← K が union 化
//   await dispatchTyped(s, { type: "SAVE" });        // どの event も通せない
//
// `let s: TypedState` で汎用ストレージに入れた瞬間 K が
// "draft" | "validated" | "saved" の union になり、`keyof Transitions[K]` =
// 共通キーの交差 = never になって、どのイベントも型で弾かれる。
//
// 結果として (B) の compile-time チェックは「state.kind が値レベルで literal
// として残っている範囲」でしか効かない。DB / queue / for ループのように
// 「kind が runtime にしか分からない」使い方では (A) と同じ状況に縮退する。
// -----------------------------------------------------------------------------
// 03 / 04 (type-state) との比較
// -----------------------------------------------------------------------------
//
//                     03 / 04                  | 05 (これ)
// ------------------ ------------------------- | ------------------------------
// 状態の置き場       class インスタンス        | 判別 union の値
// 遷移               メソッド呼び出し          | dispatch(state, event)
// 順序ミス           compile-time              | compile-time (kind が literal な間)
// 状態の観測         しづらい (型に閉じる)     | 簡単 (値だから)
// 永続化             JSON にしづらい           | JSON にしやすい (kind + payload)
// for / switch 親和  ✅                         | ❌ (union 化で型が崩れる)
// -----------------------------------------------------------------------------
// 設計判断のチェックリスト
// -----------------------------------------------------------------------------
//
//   値そのものの区別がしたい
//     → Phantom Type             (Email vs URL / UserId vs OrderId)
//
//   処理の順序ミスを止めたい (本筋)
//     → Type-State Pattern       (Builder / Connection / Form の段階)
//
//   状態を値として扱いたい (永続化 / observable)
//     → Dispatcher Pattern + 型付き遷移表 (= 本ファイルの B)、または xstate
//
//   本格的な状態機械が要る (並列状態 / 階層状態 など)
//     → runtime の状態機械ライブラリに任せる (別レイヤー)
//
//   副作用モデル全体を扱いたい (並行 / キャンセル / エラー型)
//     → エフェクト系ライブラリに任せる (解決レイヤーが違う)
//
// -----------------------------------------------------------------------------
// 「型は何を表すか」ではなく「状態をどこに置くか」が設計の本丸。
// -----------------------------------------------------------------------------
