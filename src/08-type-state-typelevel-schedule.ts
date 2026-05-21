// =============================================================================
// 08. Type-State × Type-Level Schedule — 副作用も状態遷移も「型に積み上げる」
// =============================================================================
//
// 07 まででの整理:
//   03 / 04 (純 Type-State)        : 状態遷移は型で守れる。副作用は即時実行
//   libraries/effect.ts (純 Effect): 副作用を 値 として扱う (= 遅延実行)。順序は
//                                    型で守らない (データ依存に乗るだけ)
//   07 (Type-State × Effect)       : 順序は型、副作用は Effect
//
// このファイルはさらに踏み込み:
//   - 副作用は 即時実行しない。各 Step は「自身を実行する関数 fn」を持つ ─
//     つまり関数を積み上げる (= Effect.tryPromise の最小版)
//   - これまで積んだ Step を 型レベルのタプル Steps に蓄積する
//   - 各メソッドは「直前の状態」ではなく「Steps の履歴」で呼び出し可否を判定
//   - .run() は積まれた fn をただ順に呼ぶだけ (= 中央 interpreter を持たない)
//
// 効くポイント:
//   ✅ 副作用は遅延される。`.run()` を呼ぶまで何も起きない
//   ✅ Hover した瞬間に「これから何が走るか」が タプル型 として全部見える
//   ✅ Has<Steps, X> で「履歴に X があるか?」を型レベルに問える
//   ✅ → "validate → log → save" のような中間 Step を挟んでも save が呼べる
//   ✅ run() の中に switch / dispatcher を書かない。step ごとのロジックは
//       step 追加メソッドの中で完結する (= 拡張時に run を触らない)
//
// 設計上の鍵: なぜ S (直前状態) ではなく Steps (履歴) で gate するか
//
//   素朴な設計:
//     save(this: Program<"validated", ...>): Program<"saved", ...>
//       → save の前に "validated" 状態で居続けないといけない
//       → validate と save の間に "log" を挟むと、状態が "logged" に進んで
//         save が呼べなくなる
//
//   履歴ベース:
//     save(this: Has<Steps, ValidateStep> extends true ? Program<Steps> : never)
//       → 「validate が履歴のどこかにあれば」save 可能
//       → 中間に log や retry を挟んでも、validate の事実は履歴に残るので OK
//
// 限界:
//   - タプル長が伸びるほど TS の型計算が重くなる
//   - for ループや if 分岐で動的に積むとタプルが配列 union に潰れて恩恵消失
//   - 並行 / キャンセル / リトライまで型に乗せたくなると Effect の世界へ
// =============================================================================

type UserData = {
    name: string;
    age: number;
};

// -----------------------------------------------------------------------------
// 1) Step 群 ── 「タグ + 自分自身を実行する関数」
// -----------------------------------------------------------------------------
//
// discriminator `type` は「Has<Steps, ValidateStep> 的な型レベル検査」用、
// `fn` は「実行時に呼ばれるクロージャ」。各 step 追加メソッドが fn を組み立てて
// タプルに push する。run() 側は中央 switch を持たず、fn を順番に呼ぶだけ。

type StepFn = () => Promise<void>;

type ValidateStep = { readonly type: "validate"; readonly fn: StepFn };
type SaveStep = { readonly type: "save"; readonly fn: StepFn };
type NotifyStep = { readonly type: "notify"; readonly fn: StepFn };
// ↓ 中間に挟まる neutral な step の例 (前提なし)
type LogStep = { readonly type: "log"; readonly fn: StepFn };
type Step = ValidateStep | SaveStep | NotifyStep | LogStep;

// -----------------------------------------------------------------------------
// 2) 型レベル「履歴に X が含まれるか?」
// -----------------------------------------------------------------------------
//
//   Steps[number]  : タプルの要素を全部 union 化 (例: ValidateStep | SaveStep)
//   Extract<U, T>  : union から T に合致する要素だけ抽出
//   ... extends never ? false : true  : 抽出結果が空なら false、あれば true
//
// Steps が空タプル `[]` のとき Steps[number] は never。Extract<never, X> も never
// になるので、Has<[], X> は false に縮約する (= 当然「何も履歴に無い」)。

type Has<Steps extends readonly Step[], T extends Step> =
    Extract<Steps[number], T> extends never ? false : true;

// -----------------------------------------------------------------------------
// 3) Program<Steps> ── 状態は持たない (= 履歴がそのまま状態)
// -----------------------------------------------------------------------------
//
// 型パラメータ:
//   Steps : これまでに積んだ Step のタプル型 (= 順序つき履歴)
//
// チェインメソッドは
//   Program<Steps> -> Program<readonly [...Steps, この操作の Step]>
// と、履歴の末尾に追記する形で型を進化させる。

class Program<Steps extends readonly Step[]> {
    // 03 と同じ流儀の phantom field。型レベルでのみ存在し、コンパイル後の JS
    // からは消える (declare → 実行時には _schedule というプロパティは無い)。
    // Steps の追跡はこの 1 行で完結し、構造的型付け上 Program<A> と Program<B>
    // は別物として扱われる。
    private declare readonly _schedule: Steps;

    private constructor(
        private readonly data: UserData,
        // ランタイム用: ただの Step 配列。タプル型としては扱わない。
        // _schedule (型レベルの schedule) との対応は append() で保証する。
        private readonly steps: readonly Step[],
    ) {}

    static start(data: UserData): Program<readonly []> {
        return new Program<readonly []>(data, []);
    }

    // すべての step 追加メソッドはこのヘルパに集約。
    // 戻り側で Program<readonly [...Steps, T]> と型を明示することで、
    // ランタイムの「ただの push」を型レベルの「タプル末尾追記」に持ち上げる。
    private append<T extends Step>(step: T): Program<readonly [...Steps, T]> {
        return new Program<readonly [...Steps, T]>(this.data, [...this.steps, step]);
    }

    // ---- 前提なしで呼べる step --------------------------------------------
    //
    // 各メソッドが「自分の step が何をするか」を fn の中に閉じ込めて push する。
    // 拡張するときに run() を触る必要はない (= ロジックの所在は step 追加メソッド)。

    validate(): Program<readonly [...Steps, ValidateStep]> {
        const data = this.data;
        return this.append<ValidateStep>({
            type: "validate",
            fn: async () => {
                console.log("[validate]", data.name);
                if (data.name.length === 0 || data.age < 0) {
                    throw new Error("invalid");
                }
            },
        });
    }

    log(message: string): Program<readonly [...Steps, LogStep]> {
        return this.append<LogStep>({
            type: "log",
            fn: async () => {
                console.log("[log]    ", message);
            },
        });
    }

    // ---- 履歴 gate 付きの step --------------------------------------------
    //
    // `this:` 制約を conditional type にする。前提が満たされていなければ
    // this の型が `never` になり、そもそも呼べなくなる。

    // save: 履歴に validate が「どこかに」あれば呼べる
    save(
        this: Has<Steps, ValidateStep> extends true ? Program<Steps> : never,
    ): Program<readonly [...Steps, SaveStep]> {
        const data = this.data;
        return this.append<SaveStep>({
            type: "save",
            fn: async () => {
                console.log("[save]   ", data.name);
                // 本番ならここで await db.insert(data)
            },
        });
    }

    // notify: 履歴に save が「どこかに」あれば呼べる
    notify(
        this: Has<Steps, SaveStep> extends true ? Program<Steps> : never,
    ): Program<readonly [...Steps, NotifyStep]> {
        const data = this.data;
        return this.append<NotifyStep>({
            type: "notify",
            fn: async () => {
                console.log("[notify] ", data.name);
                // 本番ならここで await notifier.send(data)
            },
        });
    }

    // ---- 実行 --------------------------------------------------------------
    // 順序強制は チェイン段階で済んでいる。run は中央 switch を持たず、
    // 積まれた fn を順に await するだけ。
    async run(): Promise<void> {
        for (const step of this.steps) {
            await step.fn();
        }
    }
}

// -----------------------------------------------------------------------------
// 4) 中間 step を挟んでもチェインが繋がる
// -----------------------------------------------------------------------------

const program = Program.start({ name: "test", age: 30 })
    .validate()
    .log("validated; about to save") // ← 中間 step が挟まる
    .save() //                                 ← 直前は log だが validate は履歴にある → 呼べる
    .log("saved; about to notify") // ← また中間 step
    .notify(); //                              ← 直前は log だが save は履歴にある → 呼べる

// inspector: schedule が型に乗っているのを確認
type ScheduleOf<P> = P extends Program<infer Steps> ? Steps : never;
type AssertEq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type _Schedule = ScheduleOf<typeof program>;
//   ^? readonly [ValidateStep, LogStep, SaveStep, LogStep, NotifyStep]
type _Check = AssertEq<_Schedule, readonly [ValidateStep, LogStep, SaveStep, LogStep, NotifyStep]>;
void (null as unknown as _Check);

// -----------------------------------------------------------------------------
// 5) 実行
// -----------------------------------------------------------------------------

console.log("--- run schedule ---");
await program.run();

// -----------------------------------------------------------------------------
// 6) ❌ 型で止まるパターン (= 順序強制)
// -----------------------------------------------------------------------------

async function _typeOnlyExamples() {
    // (a) validate を通さずに save → 履歴に ValidateStep が無いので this: never
    // @ts-expect-error  validate していない program では save が呼べない
    Program.start({ name: "x", age: 1 }).save();

    // (b) save を通さずに notify → 履歴に SaveStep が無いので this: never
    // @ts-expect-error  save していない program では notify が呼べない
    Program.start({ name: "x", age: 1 }).validate().notify();

    // (c) ✅ 中間 log を挟んでも save / notify は通る (= 履歴 gate の御利益)
    const ok = Program.start({ name: "x", age: 1 })
        .validate()
        .log("...")
        .log("...")
        .save()
        .log("...")
        .notify();
    await ok.run();
}
void _typeOnlyExamples;

// -----------------------------------------------------------------------------
// 7) ここまでの設計上のポイント
// -----------------------------------------------------------------------------
//
// (a) S (直前状態) を持たず、Steps (履歴) だけを型に持つ
//     → 「直前が validated でないと save できない」のような硬直が消える
//     → 履歴に validate があれば、間に log / retry / 何でも挟んで save 可能
//
// (b) `this:` 制約を conditional type で書く
//        save(this: Has<Steps, ValidateStep> extends true ? Program<Steps> : never)
//     → 前提を満たさないと receiver が never になり、メソッドが「無い」状態に
//     → 03 の `this: Program<"validated">` の一般化
//
// (c) Step が「タグ + fn」。run は fn を呼ぶだけで中央 switch を持たない
//     → 新しい step を増やしても run() に手を入れる必要がない
//     → 各 step のロジックは step 追加メソッドの中で閉じる (= local reasoning)
//
// (d) 型レベルで Steps を観測できる (件数 / 末尾 / 含むか / 並び順) 全部 type で完結
//
// -----------------------------------------------------------------------------
// 8) 限界
// -----------------------------------------------------------------------------
//
// (a) タプル長 (= step 数) が増えると `[...Steps, X]` の連結が型計算を重くする。
//     実用では「数十段で止まる直列パイプ」が現実的な上限。
//     for ループや if 分岐で動的に積むと、型は配列の union に潰れてタプルの
//     恩恵が消える (= ただの (Step)[] になる)。
//
// (b) 「失敗で短絡」「並行」「キャンセル」まで型に積みたくなると、Step に
//     成功型 / エラー型 / Requirements を載せる必要が出てくる。
//     真面目にやると Free Monad / Effect.ts の構造に収束する。軽量さの旨味は
//     この辺りで消えるので、その時は素直に Effect を使う。
//
// (c) 「同じ step を 2 回呼んだら NG」のような重複検査までやりたい場合、
//     Has<Steps, X> ではなく Count<Steps, X> 的なヘルパが必要になる。
//     型レベルで再帰になるので、深さ制限に注意。
//
// -----------------------------------------------------------------------------
// 結論:
//   - "順序制約" + "副作用の遅延実行" + "実行前 schedule 観測" を軽量に欲しいなら、
//     Steps タプルだけを型に持ち、各 step は「タグ + fn」、Has<Steps, X> で gate する
//   - 中央 interpreter (switch) は要らない。step ごとのロジックは追加メソッド側に
//   - 直列で本数が決まっているパイプライン (DB migration / build pipeline /
//     CLI ワークフロー) に fit する
//   - 汎用副作用システムへ拡張するなら Effect.ts に乗り換える
// -----------------------------------------------------------------------------
