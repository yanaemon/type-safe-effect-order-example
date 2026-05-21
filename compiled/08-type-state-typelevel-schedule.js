// =============================================================================
// 08. Type-State × Type-Level Schedule — 業務ロジックと scheduler を分離
// =============================================================================
//
// 07 まででの整理:
//   03 / 04 (純 Type-State)        : 状態遷移は型で守れる。副作用は即時実行
//   libraries/effect.ts (純 Effect): 副作用を 値 として扱う (= 遅延実行)。順序は
//                                    型で守らない (データ依存に乗るだけ)
//   07 (Type-State × Effect)       : 順序は型、副作用は Effect
//
// このファイルでやりたいこと:
//   - 副作用を Step (関数) として積み上げ、.run() で初めて実行する
//   - これまで積んだ step を 型レベルのタプル に蓄積する (実行前に schedule 観測可能)
//   - 業務ロジック (UserService) と scheduler の実装を 別々のレイヤー に分ける
//   - 順序強制は UserService<S> 側の `this:` 制約だけで済ませる
//     (Schedule lib は順序のことを知らない)
//
// レイヤー:
//   A. Schedule lib  : 汎用。step タプルを積んで run で順に呼ぶだけ。業務ロジック 0
//   B. UserService   : 03 のままの業務クラス。phantom S で順序を表現
//   C. コンポジション : .add(step) で両者を繋ぐ。step は UserService のメソッドを
//                       async ラップしただけのもの
//
// 効くポイント:
//   ✅ UserService は 03 と同じ (= 既存実装を保持)
//   ✅ Schedule は domain-agnostic。validate/save/notify を知らない
//   ✅ 副作用は遅延される。`.run()` まで何も起きない
//   ✅ 順序ミスは UserService<S> の `this:` 制約で型エラー
//   ✅ Schedule の型に Steps タプル + Input/Output が乗る (hover で全把握)
//   ✅ run は中央 switch を持たず、step.fn を順に await するだけ
//
// 限界:
//   - タプル長が伸びるほど TS の型計算が重くなる
//   - if 分岐 / 並行 / cancellation まで型に乗せたくなると Effect.ts の世界へ
// =============================================================================
class Schedule {
    steps;
    constructor(
    // ランタイム用: ただの step 配列。型は (StepFn 入出力は any) として保持し、
    // 型レベルの schedule との対応は add() / start() で保証する
    steps) {
        this.steps = steps;
    }
    static start() {
        return new Schedule([]);
    }
    add(step) {
        const next = [...this.steps, step];
        return new Schedule(next);
    }
    async run(input) {
        let ctx = input;
        for (const step of this.steps) {
            ctx = await step.fn(ctx);
        }
        return ctx;
    }
}
class UserService {
    data;
    constructor(data) {
        this.data = data;
    }
    validate() {
        console.log("[validate]", this.data.name);
        if (this.data.name.length === 0 || this.data.age < 0) {
            return null;
        }
        return new UserService(this.data);
    }
    async save() {
        console.log("[save]   ", this.data.name);
        return new UserService(this.data);
    }
    async notify() {
        console.log("[notify] ", this.data.name);
        return this;
    }
}
// -----------------------------------------------------------------------------
// レイヤー C: コンポジション — .add で UserService メソッドを Schedule に乗せる
// -----------------------------------------------------------------------------
//
// 各 step の fn は UserService のメソッドを async でラップしているだけ。
// 業務ロジックは UserService の中、scheduling は Schedule の中、と完全に分離。
const program = Schedule.start()
    .add({
    type: "validate",
    fn: async (u) => {
        const v = u.validate();
        if (!v)
            throw new Error("validation failed");
        return v; // UserService<"validated">
    },
})
    .add({
    type: "save",
    fn: async (u) => u.save(), // u: UserService<"validated">, returns <"saved">
})
    .add({
    type: "notify",
    fn: async (u) => u.notify(), // u: UserService<"saved">, returns <"saved">
});
void [
    null,
    null,
    null,
];
// -----------------------------------------------------------------------------
// 実行
// -----------------------------------------------------------------------------
console.log("--- run schedule ---");
const result = await program.run(new UserService({ name: "test", age: 30 }));
//      ^? UserService<"saved">
void result;
// -----------------------------------------------------------------------------
// ❌ 型で止まるパターン
// -----------------------------------------------------------------------------
//
// 順序強制は UserService 側の `this:` 制約に乗っているだけ。Schedule は何も
// 制約していないが、step.fn の引数型と現在の Output が合わないことで TS が
// 自然に止める。
async function _typeOnlyExamples() {
    // (a) validate を通さずに save を積もうとする
    //     → save.fn の引数 UserService<"validated"> と、現在の Output
    //       UserService<"draft"> が一致しない
    Schedule.start().add({
        type: "save",
        // @ts-expect-error  u は UserService<"draft">。save() の this: 制約に合わない
        fn: async (u) => u.save(),
    });
    // (b) notify を save より先に積もうとする
    Schedule.start()
        .add({
        type: "validate",
        fn: async (u) => {
            const v = u.validate();
            if (!v)
                throw new Error();
            return v;
        },
    })
        .add({
        type: "notify",
        // @ts-expect-error  u は UserService<"validated">。notify() は this: UserService<"saved"> を要求
        fn: async (u) => u.notify(),
    });
}
void _typeOnlyExamples;
export {};
// -----------------------------------------------------------------------------
// 設計上のポイント
// -----------------------------------------------------------------------------
//
// (a) Schedule lib は domain を知らない
//     - validate/save/notify の名前すら知らない (タグは任意の string)
//     - 業務ロジックの差し替え (例: UserService → OrderService) で
//       Schedule のコードに手を入れる必要は無い
//
// (b) UserService は 03 と同じ
//     - phantom S と `this:` 制約はそのまま。型ステートの実装はライブラリ独立
//     - 他の使い方 (即時実行) でもそのまま使える
//
// (c) 順序強制は「型フロー」で完結
//     - 各 step の fn の引数型 = 直前 step の Output 型
//     - UserService<"draft"> -> validate -> <"validated"> -> save -> <"saved">
//       と型が流れる。順序を間違えると fn の引数型ミスマッチで TS が止める
//
// (d) Step の型情報は二重に乗る
//     - 型レベル: Steps タプル (= 観測用 phantom)
//     - 型フロー: Input / Output (= 順序制約)
//     どちらもランタイムには出ない (declare phantom field と generic 型パラメータ)
//
// -----------------------------------------------------------------------------
// 結論:
//   - 「scheduling 機構」と「業務ロジック」は別レイヤーに切れる
//   - 業務側は 03 の type-state を維持 (= 既存実装はそのまま)
//   - lib は AnyStep の積み上げと逐次 await だけ。validate/save/notify を知らない
//   - 順序は UserService 側の型フローが自動的に守る
// -----------------------------------------------------------------------------
