// =============================================================================
// 06. Type-State × Effect — ハイブリッド
// =============================================================================
//
// 03 (純 Type-State)         : 順序は型で守れる。エラー / 並行 / リトライ等の
//                              副作用モデルは Promise + try/catch で都度書く。
// libraries/effect.ts (純 Effect):
//                              エラー / 並行を型でモデリングできるが、順序は
//                              「データ依存で繋ぐ」だけで、間違って書けば通る。
//
// このファイルは両方の良いとこ取り。
//   - 状態 × 振る舞いは UserService<S> に閉じ込める (03 と同じ)
//   - 各メソッドは「即時実行」せず Effect を返す
//   - 合成は pipe + Effect.flatMap (または Effect.gen)
//
// 効くポイント:
//   ✅ 順序ミスは type-state で compile-time に止まる
//   ✅ エラーは Effect の型に乗る (例外を投げない)
//   ✅ 並行 / リトライ / タイムアウト / 依存注入は Effect の道具で書ける
// =============================================================================

import { Effect, pipe } from "effect";

type UserData = {
    name: string;
    age: number;
};

type State = "draft" | "validated" | "saved";

// エラーは値として宣言 (03 では `| null` だったところを型付きエラーに)
class ValidationError {
    readonly _tag = "ValidationError";
    constructor(readonly reason: string) {}
}
class SaveError {
    readonly _tag = "SaveError";
    constructor(readonly cause: unknown) {}
}
class NotifyError {
    readonly _tag = "NotifyError";
    constructor(readonly cause: unknown) {}
}

class UserService<S extends State = "draft"> {
    // phantom: 型だけのフィールド。コンパイル後の JS では消える
    private declare readonly _state: S;
    constructor(private readonly data: UserData) {}

    // this: で状態を絞り、戻り値は Effect。失敗パスは Effect.fail に乗せる
    //
    // Effect の強みを活かすなら失敗条件ごとに別の ValidationError を返せる:
    //   if (this.data.name.length === 0) return Effect.fail(new ValidationError("name is empty"));
    //   if (this.data.age < 0)            return Effect.fail(new ValidationError("age is negative"));
    // (= エラー型の値が「どこで失敗したか」を保持できる)
    // このファイルでは他の例 (01-05) と統一して 1 つの check にまとめている。
    validate(this: UserService<"draft">): Effect.Effect<UserService<"validated">, ValidationError> {
        console.log("[validate]", this.data.name);
        if (this.data.name.length === 0 || this.data.age < 0) {
            return Effect.fail(new ValidationError("invalid input"));
        }
        return Effect.succeed(new UserService<"validated">(this.data));
    }

    save(this: UserService<"validated">): Effect.Effect<UserService<"saved">, SaveError> {
        return Effect.tryPromise({
            try: async () => {
                console.log("[save]   ", this.data.name);
                return new UserService<"saved">(this.data);
            },
            catch: (cause) => new SaveError(cause),
        });
    }

    notify(this: UserService<"saved">): Effect.Effect<void, NotifyError> {
        return Effect.tryPromise({
            try: async () => {
                console.log("[notify] ", this.data.name);
            },
            catch: (cause) => new NotifyError(cause),
        });
    }
}

const input: UserData = { name: "test", age: 30 };

// ----- ✅ pipe + flatMap でチェーン ------------------------------------------
const userService = new UserService(input);
const program = pipe(
    userService.validate(),
    Effect.flatMap((s) => s.save()),
    Effect.flatMap((s) => s.notify()),
);

console.log("--- pipe style ---");
await Effect.runPromise(program);

// ----- Effect.gen 流でも書ける -----------------------------------------------
const programGen = Effect.gen(function* () {
    const validated = yield* new UserService(input).validate();
    const saved = yield* validated.save();
    yield* saved.notify();
});

console.log("--- gen style (同じ結果) ---");
await Effect.runPromise(programGen);

// ----- 失敗ケース: 例外ではなく Effect の Exit に Failure として現れる --------
console.log("--- failure ---");
const failedProgram = pipe(
    new UserService({ name: "", age: 30 }).validate(),
    Effect.flatMap((s) => s.save()),
    Effect.flatMap((s) => s.notify()),
);
const exit = await Effect.runPromiseExit(failedProgram);
console.log("[exit]   ", exit._tag); // "Failure"

// ----- ❌ 順序ミスは type-state で compile-time に止まる ----------------------
function _typeOnlyExamples() {
    const u = new UserService(input);

    // @ts-expect-error  validate をスキップ (u は UserService<"draft">)
    u.save();

    // @ts-expect-error  validate をスキップして notify
    u.notify();

    // pipe の中でも同じ。validated に対して notify は呼べない
    pipe(
        u.validate(),
        // @ts-expect-error  save をスキップして notify (s は UserService<"validated">)
        Effect.flatMap((s) => s.notify()),
    );
}
void _typeOnlyExamples;

// -----------------------------------------------------------------------------
// 役割分担まとめ
// -----------------------------------------------------------------------------
//
//                   03 (pure type-state)  effect.ts (pure Effect)  06 (これ)
// ----------------- -------------------- ----------------------- ----------------
// 順序ミス検知       compile-time         止まらない              compile-time
// エラー             null / throw         Effect.fail (型付き)    Effect.fail
// 並行 / retry       手書き               Effect の道具           Effect の道具
// 依存注入           constructor          Effect.Context          両方使える
//
// 結論:
//   ・順序は class の型パラメータ (= type-state) で守る
//   ・エラー / 並行 / リソースは Effect の語彙で扱う
//   ・両者は目的が違うので「同じ箱」に同居できる
//
// 「型は何を表すか」より「状態をどこに置くか」 ─ そして「副作用をどう記述するか」
// は別軸。組み合わせれば両方の利点が取れる。
