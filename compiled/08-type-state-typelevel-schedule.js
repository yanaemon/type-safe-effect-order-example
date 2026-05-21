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
//   - 副作用を即時実行しない (Step というデータに変える ─ Effect.tryPromise 的)
//   - これまで積んだ Step を 型レベルのタプル Steps に蓄積する
//   - 各メソッドは「直前の状態」ではなく「Steps の履歴」で呼び出し可否を判定
//   - .run() は schedule が完成している場合だけ呼べる
//
// 効くポイント:
//   ✅ 副作用は Step。`.run()` を呼ぶまで何も起きない (= 遅延実行)
//   ✅ Hover した瞬間に「これから何が走るか」が タプル型 として全部見える
//   ✅ Has<Steps, X> で「履歴に X があるか?」を型レベルに問える
//   ✅ → "validate → log → save" のような中間 Step を挟んでも save が呼べる
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
class Program {
    data;
    steps;
    constructor(data, steps) {
        this.data = data;
        this.steps = steps;
    }
    static start(data) {
        return new Program(data, []);
    }
    // ---- 前提なしで呼べる step --------------------------------------------
    // validate は前提なし (= 最初に呼ぶ前提)
    validate() {
        const step = { type: "validate", data: this.data };
        return new Program(this.data, [...this.steps, step]);
    }
    // log は前提なし。中間にいくらでも挟める neutral な step
    log(message) {
        const step = { type: "log", message };
        return new Program(this.data, [...this.steps, step]);
    }
    // ---- 履歴 gate 付きの step --------------------------------------------
    //
    // `this:` 制約を conditional type にする。前提が満たされていなければ
    // this の型が `never` になり、そもそも呼べなくなる。
    // save: 履歴に validate が「どこかに」あれば呼べる
    save() {
        const step = { type: "save", data: this.data };
        return new Program(this.data, [...this.steps, step]);
    }
    // notify: 履歴に save が「どこかに」あれば呼べる
    notify() {
        const step = { type: "notify", data: this.data };
        return new Program(this.data, [...this.steps, step]);
    }
    // ---- 実行 --------------------------------------------------------------
    // .run() は「履歴に notify がある」= 全工程に到達した program だけ呼べる
    async run() {
        for (const step of this.steps) {
            switch (step.type) {
                case "validate":
                    console.log("[validate]", step.data.name);
                    if (step.data.name.length === 0 || step.data.age < 0) {
                        throw new Error("invalid");
                    }
                    break;
                case "save":
                    console.log("[save]   ", step.data.name);
                    break;
                case "notify":
                    console.log("[notify] ", step.data.name);
                    break;
                case "log":
                    console.log("[log]    ", step.message);
                    break;
            }
        }
    }
}
// -----------------------------------------------------------------------------
// 4) 中間 step を挟んでもチェインが繋がる (= 元の質問の答え)
// -----------------------------------------------------------------------------
const program = Program.start({ name: "test", age: 30 })
    .validate()
    .log("validated; about to save") // ← 中間 step が挟まる
    .save() //                                 ← 直前は log だが validate は履歴にある → 呼べる
    .log("saved; about to notify") // ← また中間 step
    .notify(); //                              ← 直前は log だが save は履歴にある → 呼べる
void null;
// -----------------------------------------------------------------------------
// 5) 実行
// -----------------------------------------------------------------------------
console.log("--- run schedule ---");
await program.run();
// -----------------------------------------------------------------------------
// 6) ❌ 型で止まるパターン
// -----------------------------------------------------------------------------
async function _typeOnlyExamples() {
    // (a) validate を通さずに save → 履歴に ValidateStep が無いので this: never
    // @ts-expect-error  validate していない program では save が呼べない
    Program.start({ name: "x", age: 1 }).save();
    // (b) save を通さずに notify → 履歴に SaveStep が無いので this: never
    // @ts-expect-error  save していない program では notify が呼べない
    Program.start({ name: "x", age: 1 }).validate().notify();
    // (c) 完成前に run → 履歴に NotifyStep が無いので this: never
    const partial = Program.start({ name: "x", age: 1 }).validate().save();
    // @ts-expect-error  notify していない program は run できない
    await partial.run();
    // (d) ✅ 中間 log を挟んでも save / notify は通る
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
export {};
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
// (c) 副作用は Step (データ)。`.run()` の interpreter が初めて実行する
//     → 「組み立て」と「実行」が分離、test では interpreter を差し替えられる
//
// (d) 型レベルで Steps を観測できる (件数 / 末尾 / 含むか / 並び順) 全部 type で完結
//     → "ある条件を満たす schedule しか run できない" を型で書ける
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
//     Steps タプルだけを型に持って、各メソッドは Has<Steps, X> で gate する
//   - 直前状態 S での gate より柔軟 (中間 step を挟める)
//   - 直列で本数が決まっているパイプライン (DB migration / build pipeline /
//     CLI ワークフロー) に fit する
//   - 汎用副作用システムへ拡張するなら Effect.ts に乗り換える
// -----------------------------------------------------------------------------
