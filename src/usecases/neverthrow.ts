// =============================================================================
// usecases/neverthrow — 「型付きエラーをチェインで運ぶ」を提供するライブラリ
//                                                  (内部実装: Phantom Pipeline 2 次元版)
// =============================================================================
//
// usecases 第三弾。zod が「実行時バリデーション」を、Kysely が「型安全な SQL
// 構築」を売っていたのに対し、neverthrow が売っているのは
//   - throw を使わない (= 関数のシグネチャに失敗が現れる)
//   - 失敗の種類を 型 で持つ
//   - 値を `.map / .andThen` でチェインしながら、エラー型は union として蓄積
// という「Rust 風 Result 型」一式。
//
// その実装は本編 02 (Phantom Pipeline) と同じ phantom 型パラメータの上に乗って
// いるが、2 次元 (成功型 T / 失敗型 E) になっている、というのが面白いところ。
//
// ─── neverthrow の内部で何が起きているか ────────────────────────────────────
//
//   type Result<T, E> = Ok<T, E> | Err<T, E>;
//   class ResultAsync<T, E> { ... }
//
//   - T : 成功時に運ぶ値の型      (= "成功側" の phantom 軸)
//   - E : 失敗時に運ぶエラーの型  (= "失敗側" の phantom 軸)
//
//   チェインメソッドはこの 2 軸を別々に進化させる:
//
//     .map(f: T => U)              : Result<T, E> -> Result<U, E>       ← T だけ動く
//     .mapErr(f: E => F)           : Result<T, E> -> Result<T, F>       ← E だけ動く
//     .andThen(f: T => Result<U,F>): Result<T, E> -> Result<U, E | F>   ← E が union で蓄積
//
//   最後の .andThen が今回のキー。
//   段ごとに違うエラー型が「全部 union として残る」ので、
//   最終チェイン後の型を見ればパイプライン全体で起こりうる失敗が一覧できる。
//
//   = 02 で `UserData & { __validated } & { __saved }` と進めていた phantom
//   ラベルが、ここでは 2 軸 (T, E) に整理され、しかも E は union 蓄積される、
//   という拡張版になっている。
//
// ─── libraries/effect.ts との位置関係 ────────────────────────────────────────
//   Effect.ts も「失敗を値で持つ」「順序ミスは型では止めない」という性質を
//   共有する。違いは:
//     - Effect:      並行 / cancellation / Scope / Layer / 依存注入 まで一式
//     - neverthrow: Result / ResultAsync の薄いラッパ。fp の入口として軽い
//   どちらも「順序ミスを compile-time に止める」目的ではない (= 02/03 と別軸)。
// =============================================================================

import { err, errAsync, ok, okAsync, type Result, ResultAsync } from "neverthrow";

type UserData = {
    name: string;
    age: number;
};

// -----------------------------------------------------------------------------
// 1) エラーを「値の型」として宣言する
// -----------------------------------------------------------------------------
//
// throw する代わりに、識別子付きの error class を返す。
// `_tag` を付けておくと後段で discriminated union として扱いやすい。

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

// -----------------------------------------------------------------------------
// 2) 各 step は Result / ResultAsync を返す (= 例外を投げない)
// -----------------------------------------------------------------------------
//
// シグネチャを見るだけで「成功で何が出てきて、失敗で何が起きうるか」が
// 両方分かる。これが neverthrow が売っている DX のキモ。

const validate = (input: UserData): Result<UserData, ValidationError> => {
    console.log("[validate]", input.name);
    if (input.name.length === 0 || input.age < 0) {
        return err(new ValidationError("invalid input"));
    }
    return ok(input);
};

const save = (input: UserData): ResultAsync<UserData, SaveError> =>
    ResultAsync.fromPromise(
        (async () => {
            console.log("[save]   ", input.name);
            return input;
        })(),
        (cause) => new SaveError(cause),
    );

const notify = (input: UserData): ResultAsync<void, NotifyError> =>
    ResultAsync.fromPromise(
        (async () => {
            console.log("[notify] ", input.name);
        })(),
        (cause) => new NotifyError(cause),
    );

// -----------------------------------------------------------------------------
// 3) チェイン: E が union として蓄積されるのを目で見る
// -----------------------------------------------------------------------------
//
//   validate(input)                                : Result<UserData, ValidationError>
//     .asyncAndThen(save)                          : ResultAsync<UserData, ValidationError | SaveError>
//     .andThen(notify)                             : ResultAsync<void,     ValidationError | SaveError | NotifyError>
//
// 各 .andThen の戻り型を hover で見ると、E が前段の union に新しいエラー型を
// 足した形になっているのが分かる ── 02 phantom pipeline が 2 軸に増えた姿。

const program = (input: UserData) =>
    validate(input) //                                  : Result<UserData, ValidationError>
        .asyncAndThen(save) //                          : ResultAsync<UserData, ValidationError | SaveError>
        .andThen(notify); //                            : ResultAsync<void,     ValidationError | SaveError | NotifyError>

// inspector: 蓄積した E の中身を compile time で確認
type _ProgramErr = InferAsyncErr<ReturnType<typeof program>>;
type _ProgramErrOK = AssertEq<_ProgramErr, ValidationError | SaveError | NotifyError>;
//   ^? true  ← E が ちゃんと 3 つの union になっている

type InferAsyncErr<R> = R extends ResultAsync<infer _T, infer E> ? E : never;
type AssertEq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// -----------------------------------------------------------------------------
// 4) 実行: success / failure を分けて受け取る
// -----------------------------------------------------------------------------
//
// .match(onOk, onErr) で discriminated union を網羅的に扱える。
// _tag で分岐すれば「どの種類の失敗か」も型安全に追える。

console.log("--- happy path ---");
await program({ name: "test", age: 30 }).match(
    () => console.log("[done]"),
    (e) => console.log("[unreachable]", e),
);

console.log("--- validation failure ---");
await program({ name: "", age: 30 }).match(
    () => console.log("[unreachable]"),
    (e) => {
        // _tag による narrowing
        switch (e._tag) {
            case "ValidationError":
                console.log("[fail]   validation:", e.reason);
                break;
            case "SaveError":
                console.log("[fail]   save:", e.cause);
                break;
            case "NotifyError":
                console.log("[fail]   notify:", e.cause);
                break;
        }
    },
);

// -----------------------------------------------------------------------------
// 5) 「順序ミスを compile-time に止める」のは neverthrow の守備範囲外
// -----------------------------------------------------------------------------
//
// neverthrow が型で守るのは
//   「失敗が起こりうる」「どの種類の失敗か」「成功で何が出るか」
// であって、「validate を呼ばずに save を呼ぶ」のような順序ミスは止まらない。
// 下のコードは型エラーにならず、validate 抜きで save が走ってしまう:

function _typeOnlyExamples() {
    const raw: UserData = { name: "test", age: 30 };
    // validate を飛ばしても neverthrow の型は何も言わない
    const skipped = save(raw).andThen(notify);
    void skipped;
}
void _typeOnlyExamples;

// 順序まで型で縛りたいなら、本編 02 の phantom ラベル付き型を Result の T に
// 入れる ── 例えば validate の戻り型を Result<ValidatedUserData, ValidationError>
// にして、save の引数を ValidatedUserData に絞る ── という合わせ技になる:

type ValidatedUserData = UserData & { readonly __validated: true };

const validateBranded = (input: UserData): Result<ValidatedUserData, ValidationError> => {
    if (input.name.length === 0 || input.age < 0) {
        return err(new ValidationError("invalid input"));
    }
    return ok(input as ValidatedUserData);
};

const saveBranded = (input: ValidatedUserData): ResultAsync<ValidatedUserData, SaveError> =>
    ResultAsync.fromPromise((async () => input)(), (cause) => new SaveError(cause));

function _brandedTypeOnlyExamples() {
    const raw: UserData = { name: "test", age: 30 };
    // @ts-expect-error  validate を通さず raw を save に渡すと止まる
    saveBranded(raw);
}
void _brandedTypeOnlyExamples;

// -----------------------------------------------------------------------------
// 結論
// -----------------------------------------------------------------------------
//   - neverthrow は「typed errors を持つ Result 型一式」を提供するライブラリ
//   - 実装は `Result<T, E>` / `ResultAsync<T, E>` という 2 軸 phantom pipeline
//   - `.andThen` でチェインすると E は union として蓄積される
//     → パイプラインの最終型が「起こりうる全エラー」の一覧になる
//   - 「順序ミス」を止める仕事はしない (= libraries/effect.ts と同じ性質)
//     順序まで型で守りたいときは 02 の phantom ラベルや 03 の type-state と組み合わせる
//
//   zod  (02 の一般化) : value に validation 済みラベルを貼る
//   Kysely (03 の一般化): builder 型をチェインで進化させる
//   neverthrow (02 の 2 軸拡張): 成功と失敗を別軸の phantom で運び、E は union 蓄積
//
// 3 つ並べると、本編で扱った 2 パターンがそれぞれ異なる「実用機能」へ
// 結晶化していることが見える。
