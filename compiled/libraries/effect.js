// =============================================================================
// Effect.ts — エフェクトを「値」として記述する
// =============================================================================
//
// Effect.ts はトークでの位置づけ的には「解決レイヤーが違う」存在。
// 並行 / キャンセル / 型付きエラー / 依存注入を統一的に扱うための
// エフェクト記述ライブラリで、Type-State Pattern が解いている
// 「コンパイル時に順序ミスを止める」とは目的が違う。
//
// このファイルでは、同じ validate → save → notify を
// Effect の流儀で書き直して、何が得られて、何が得られないかを並べる。
//
// 得られるもの:
//   - エフェクトが値になる (実行ではなく記述)
//   - エラーが型に出る (例外を投げない)
//   - pipe / Effect.gen で逐次合成。前段の失敗は短絡する
//   - retry / timeout / race / 並行などを「同じ型」で扱える
//
// 得られないもの (= ここが Type-State との違い):
//   - 「validate を呼ばずに save を呼ぶ」は Effect の型では止まらない。
//     順序は「前段の出力を後段の入力に渡す」というデータ依存で表現されるだけで、
//     呼び出し側が依存関係を無視して書けば普通に通る。
//     ↓ ファイル末尾の _typeOnlyExamples で実演する。
// =============================================================================
import { Effect, pipe } from "effect";
// エラーは値。例外を投げずに型で表現する。
class ValidationError {
    reason;
    _tag = "ValidationError";
    constructor(reason) {
        this.reason = reason;
    }
}
class SaveError {
    cause;
    _tag = "SaveError";
    constructor(cause) {
        this.cause = cause;
    }
}
class NotifyError {
    cause;
    _tag = "NotifyError";
    constructor(cause) {
        this.cause = cause;
    }
}
// -----------------------------------------------------------------------------
// 各ステップは「即時実行する関数」ではなく「Effect (= 実行記述)」を返す
// -----------------------------------------------------------------------------
// 失敗しうる純粋なチェック → Effect.fail で型に乗せる
const validate = (input) => Effect.gen(function* () {
    if (input.name.length === 0) {
        return yield* Effect.fail(new ValidationError("name is empty"));
    }
    if (input.age < 0) {
        return yield* Effect.fail(new ValidationError("age is negative"));
    }
    return input;
});
// async な副作用 (DB / 外部 API) は Effect.tryPromise で包むと、Promise rejection が
// 型付き error に変換されてエフェクトの型に乗る (例外で抜けることはない)
const save = (input) => Effect.tryPromise({
    try: async () => {
        console.log("[save]   ", input.name);
        return input;
    },
    catch: (cause) => new SaveError(cause),
});
const notify = (input) => Effect.tryPromise({
    try: async () => {
        console.log("[notify] ", input.name);
    },
    catch: (cause) => new NotifyError(cause),
});
// -----------------------------------------------------------------------------
// 合成: Effect.gen で逐次。前段が失敗するとそこで短絡する (例外なし)
// -----------------------------------------------------------------------------
const program = (input) => Effect.gen(function* () {
    const validated = yield* validate(input);
    const saved = yield* save(validated);
    yield* notify(saved);
});
// pipe スタイルでも書ける (お好みで)
const programPipe = (input) => pipe(validate(input), Effect.flatMap(save), Effect.flatMap(notify));
// -----------------------------------------------------------------------------
// 実行
// -----------------------------------------------------------------------------
console.log("--- gen style ---");
await Effect.runPromise(program({ name: "test", age: 30 }));
console.log("--- pipe style (同じ結果) ---");
await Effect.runPromise(programPipe({ name: "test", age: 30 }));
// 失敗ケース: 例外ではなく Effect の Exit に Failure として現れる
console.log("--- failure ---");
const failed = await Effect.runPromiseExit(program({ name: "", age: 30 }));
console.log("[exit]   ", failed._tag); // "Failure"
// -----------------------------------------------------------------------------
// 順序ミスは Effect の型では「止まらない」
// -----------------------------------------------------------------------------
// 下の関数は実行しない (中身は型チェックだけ通る)。
// validate を呼ばずに save を呼んでも、save を二回呼んでも、Effect 単体では
// コンパイルエラーにならない。順序は人間が「依存関係を正しく渡すか」次第。
//
// → 「呼び出し順そのものを型で禁止したい」のは Type-State Pattern の領分。
//   Effect の強みはエラー型・並行・リソース管理など別軸。
function _typeOnlyExamples(input) {
    // 順序を入れ替えても Effect の型は怒らない
    const wrong = Effect.gen(function* () {
        yield* notify(input); // 通知が先
        yield* save(input); // 保存が後
        yield* validate(input); // 検証が最後 (もう遅い)
    });
    void wrong;
}
void _typeOnlyExamples;
// 結論:
//   - Effect.ts は「副作用を値として扱い、エラー・並行・リソースを一貫した型で
//     合成する」ためのもの。順序ミスを止めるのは目的ではない。
//   - 「順序ミスをコンパイル時に止めたい」だけなら Type-State Pattern が軽量。
//   - 「並行 / キャンセル / リトライ / 依存注入を統一的に扱いたい」場合は Effect。
//   - 両者は併用可能 (Effect の中で Type-State なオブジェクトを使うのは普通)。
