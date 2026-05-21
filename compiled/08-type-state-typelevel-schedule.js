// =============================================================================
// 08. Type-State × Type-Level Schedule — 副作用も状態遷移も「型に積み上げる」
// =============================================================================
//
// 07 まででの整理:
//   03 / 04 (純 Type-State)        : 状態遷移は型で守れる。副作用は即時実行
//   libraries/effect.ts (純 Effect): 副作用を 値 として扱う (= 遅延実行)。順序は
//                                    型で守らない (データ依存に乗るだけ)
//   07 (Type-State × Effect)       : 順序は型、副作用は Effect。両良いとこ取り
//
// このファイルはもう一歩踏み込む:
//   - 03 と同じく状態は phantom 型パラメータ S に
//   - 各メソッドは即時実行しない (副作用を Step というデータに変える)
//   - 加えて、これまで積んだ Step を 型レベルの タプル として 2 つ目の型
//     パラメータ Steps に蓄積する
//   - .run() は「最終状態 ("notified") に到達した Program」だけが呼べる
//
// 結果:
//   const program = Program.start(data).validate().save().notify();
//   //   ^? Program<"notified", readonly [ValidateStep, SaveStep, NotifyStep]>
//
//   await program.run();  // ↑ の型から、走る前に schedule 全体が型で見える
//
// 効くポイント:
//   ✅ 03 の `this:` 制約で順序ミスは compile-time に止まる
//   ✅ 副作用は Step というデータ。`.run()` を呼ぶまで何も起きない (= 遅延実行)
//   ✅ Hover した瞬間に「これから何が走るか」がタプル型として全部見える
//   ✅ 型レベルで Step タプルを操作できる (件数を数える / 末尾を取る / 含むか確認)
//
// 限界 (後述):
//   - タプルが伸びるほど TS の型計算が重くなる (実用では深さの上限を意識する)
//   - 条件分岐 / 並行 / リトライ まで型に乗せたくなると Free Monad / Effect の
//     世界に近づき、軽量さの利点が消える (= その時は素直に Effect を使う)
// =============================================================================
// -----------------------------------------------------------------------------
// 2) Program<S, Steps> ── 状態 + 積み上がった schedule
// -----------------------------------------------------------------------------
//
// 型パラメータ:
//   S     : 03 と同じ phantom 状態。`this:` 制約に使う
//   Steps : これまでに積んだ Step の「タプル型」(= 順序つきリスト)
//
// チェインメソッドは
//   Program<前の状態, Steps> -> Program<次の状態, readonly [...Steps, このメソッドの Step]>
// と、両方の型パラメータを同時に進化させる。
class Program {
    data;
    steps;
    constructor(data, steps) {
        this.data = data;
        this.steps = steps;
    }
    // 初期状態は draft、Steps は空タプル
    static start(data) {
        return new Program(data, []);
    }
    validate() {
        const step = { type: "validate", data: this.data };
        // runtime はただの配列 push。型シグネチャ側でタプルとして見せる
        return new Program(this.data, [...this.steps, step]);
    }
    save() {
        const step = { type: "save", data: this.data };
        return new Program(this.data, [...this.steps, step]);
    }
    notify() {
        const step = { type: "notify", data: this.data };
        return new Program(this.data, [...this.steps, step]);
    }
    // .run() は「最終状態 = notified」に到達した Program だけが呼べる。
    // partial な (途中の) Program は型で弾かれる。
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
                    // 本番ならここで await db.insert(...)
                    break;
                case "notify":
                    console.log("[notify] ", step.data.name);
                    // 本番ならここで await notifier.send(...)
                    break;
            }
        }
    }
}
// -----------------------------------------------------------------------------
// 3) 組み立て: チェインを書いた瞬間に schedule が型に乗る
// -----------------------------------------------------------------------------
const program = Program.start({ name: "test", age: 30 }).validate().save().notify();
void [
    null,
    null,
    null,
    null,
];
// -----------------------------------------------------------------------------
// 5) 実行
// -----------------------------------------------------------------------------
console.log("--- run schedule ---");
await program.run();
// -----------------------------------------------------------------------------
// 6) ❌ 型で止まるパターン
// -----------------------------------------------------------------------------
async function _typeOnlyExamples() {
    // (a) 順序ミス: 03 と同じく this 制約で弾かれる
    const draft = Program.start({ name: "x", age: 1 });
    // @ts-expect-error  validate 前に save は呼べない
    draft.save();
    // (b) 部分プログラムは run できない
    const partial = Program.start({ name: "x", age: 1 }).validate().save();
    // partial: Program<"saved", readonly [ValidateStep, SaveStep]>
    // @ts-expect-error  "notified" でないと run() の this 制約に合わない
    await partial.run();
    // (c) 完成しても、状態が違うものに無理矢理 run はさせない
    // (型レベルで Steps が違うのは OK。状態 S が "notified" であることが run の条件)
}
void _typeOnlyExamples;
export {};
// -----------------------------------------------------------------------------
// 7) ここまでで分かること
// -----------------------------------------------------------------------------
//
// (a) 03 の「this 制約で順序」を保ちつつ、副作用を 値 (Step) として遅延できる
//     → 「組み立て」と「実行」が分離する (Effect.ts のような利点)
//
// (b) Steps が型レベルのタプルなので、実行前に schedule を任意に観測できる
//     → 「これから何が走るか」を 型 で 全把握 できる ← 元の質問の答え
//
// (c) 観測は compile-time で確定する (runtime コスト 0)
//     → "ある条件を満たす schedule しか run できない" を型で書ける
//        例: type RunnableIf<P> = IncludesNotify<P> extends true ? P : never;
//
// -----------------------------------------------------------------------------
// 8) 限界と Effect.ts への帰結
// -----------------------------------------------------------------------------
//
// (a) タプル長 (= step 数) が増えると `[...Steps, X]` の連結が型計算を重くする
//     実用では「数十段で止まる直列パイプ」が現実的な上限。
//     for ループや if 分岐で動的に step を生やすと、型は配列の union に潰れて
//     タプルの恩恵が消える (= ただの (Step)[] になる)。
//
// (b) 「失敗で短絡」「並行」「キャンセル」まで型に積みたくなると、
//     Step に成功型 / エラー型 / Requirements を載せる必要が出てくる。
//     これを真面目にやると Free Monad / Tagless Final / Effect.ts の構造に
//     収束する。軽量さの旨味はこの辺りで消えるので、その時は素直に Effect。
//
// (c) Step の payload を 値レベルまで literal に保ちたい場合は
//     `static start<const T extends UserData>(data: T)` のように const 修飾を
//     入れる。型は綺麗だが、ジェネリクスが 1 段増えるのと、`UserData` の
//     widening を抑える注意点が増える。
//
// -----------------------------------------------------------------------------
// 結論:
//   - 「03 の順序制約」 + 「Effect 的な遅延実行」 + 「実行前 schedule 観測」を
//     軽量に欲しいなら、State + Steps の 2 軸 type-state にすればよい
//   - 直列で本数が決まっているパイプライン (DB migration / build pipeline /
//     CLI ワークフロー) に fit する
//   - 汎用副作用システムへ拡張するなら Effect.ts に乗り換える方が良い
// -----------------------------------------------------------------------------
