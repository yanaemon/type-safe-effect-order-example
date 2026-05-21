// =============================================================================
// usecases/zod — 「スキーマバリデーション」を提供するライブラリ
//                                                          (内部実装: Phantom Pipeline)
// =============================================================================
//
// libraries/ が「順序制御の仕組みそのもの」を提供するのに対し、
// usecases/ は「その仕組みで作られた、別の機能を提供するライブラリ」を見る。
//
// 最初のサンプルは zod。zod の表向きの売りは
//   - 実行時バリデーション
//   - スキーマ 1 つから「型」と「parser」が同時に得られる
// だが、その実装は本編 02 (Phantom Pipeline) と同じ仕掛けに乗っている。
//
// ─── zod の内部で何が起きているか ────────────────────────────────────────────
//
//   interface $ZodType<Output, Input> {
//     _zod: { output: Output; input: Input; ... };  // ← phantom 型のみ
//   }
//
//   - `Output` / `Input` は phantom 型パラメータ (実体には乗らない)
//   - `.optional()` / `.transform()` / `.brand()` 等は
//       $ZodType<O, I> → $ZodType<O', I'>  と「型パラメータを進める」
//   - `parse(unknown): Output` は、untyped から phantom 付きの型へ
//     状態を遷移させる「validate」ステップそのもの
//
// つまり zod は、本編 02 で手書きしていた
//
//   type ValidatedUserData = UserData & { readonly __validated: true };
//   validate(input: UserData): ValidatedUserData | null
//
// と同じ phantom-pipeline を、`z.object({ ... })` と `.parse()` の API として
// 一般化した上で、実行時の検証ロジックまで束ねて提供しているライブラリ。
//
// このファイルでは:
//   1) zod が phantom 型でやっていることを目で確認する (型の昇格を辿る)
//   2) 同じ validate → save → notify を zod ベースで組み立てる
//   3) `.brand()` で本編 02 と完全に同じ phantom タグを露出させる
//   4) 「順序ミスを止める」のは zod 単体では片側だけ、を実演する
// =============================================================================
import { z } from "zod";
// -----------------------------------------------------------------------------
// 1) スキーマを宣言した瞬間、型と parser が同時に生まれる
// -----------------------------------------------------------------------------
//
// 下の `UserSchema` は値だが、その型 `typeof UserSchema` は
//   ZodObject<{ name: ZodString; age: ZodNumber }>
// であり、ZodObject の中に phantom output 型として
//   { name: string; age: number }
// を持っている。これが本編 02 の「__validated タグ付き型」に相当する位置。
const UserSchema = z.object({
    name: z.string().min(1),
    age: z.number().int().nonnegative(),
});
//   ^? { name: string; age: number }
// -----------------------------------------------------------------------------
// 2) チェイン = 型パラメータの遷移 (Type-State 的な見え方)
// -----------------------------------------------------------------------------
//
// `.optional()` などのメソッドは、ZodType<O, I> を ZodType<O | undefined, I | undefined>
// に「進める」。本編 03 (Type-State Pattern) の `this:` 制約ほど厳格な遷移制限は
// 持っていないが、戻り値の型に状態が乗って次に進む、という流れは同じ:
//
//   z.string()                          : ZodType<string, string>
//     .min(1)                           : ZodType<string, string>          (制約だけ強くなる)
//     .optional()                       : ZodType<string | undefined, ...> (output 型が進化)
//     .transform((s) => s.length)       : ZodType<number, string | undef>  (output が number に)
//     .brand<"NonEmptyLen">()           : ZodType<number & { __brand }, ...>
//
// 各 step で「次に呼べる API」と「最終的に取れる型」が変わる。
// 型パラメータが進む = phantom pipeline と同じ仕掛け。
// -----------------------------------------------------------------------------
// 3) parse() = 「untyped → 検証済み型」の状態遷移
// -----------------------------------------------------------------------------
//
//   parse: (input: unknown) => Output
//
// これは本編 02 の `validate(input: UserData): ValidatedUserData | null` と
// 同型の遷移 (null の代わりに throw / safeParse の Result 型で表現)。
// zod を「実行時バリデータ」と見るか、「unknown → phantom 付き型」の遷移関数と
// 見るかで、ライブラリの位置付けが変わる。
async function saveUser(user) {
    console.log("[save]   ", user.name);
}
async function notifyUser(user) {
    console.log("[notify] ", user.name);
}
// ----- ✅ 正しい使い方: parse を通すと型が ValidatedUserData に昇格 ----------
{
    const raw = { name: "test", age: 30 };
    const validated = UserSchema.parse(raw); // unknown → ValidatedUserData
    await saveUser(validated);
    await notifyUser(validated);
}
// ----- ❌ unknown のまま渡そうとするとコンパイルが止まる ---------------------
function _typeOnlyExamples() {
    const raw = { name: "test", age: 30 };
    // @ts-expect-error  unknown は ValidatedUserData ではない
    saveUser(raw);
}
void _typeOnlyExamples;
// -----------------------------------------------------------------------------
// 4) `.brand()` で本編 02 と完全に同じ phantom ラベルを出す
// -----------------------------------------------------------------------------
//
// 上の `ValidatedUserData = { name: string; age: number }` は、構造的に同じ
// 平のオブジェクトリテラルからも作れてしまう (構造的型付け):
//
//   const fake: ValidatedUserData = { name: "x", age: 1 };  // 通ってしまう
//
// = 「parse() を通った値」と「ただの一致するオブジェクト」が型上区別できない。
// 本編 02 で `& { readonly __validated: true }` を足していた理由がこれ。
//
// zod では `.brand<"validated">()` がその役割。schema の output 型に
// `z.$brand<"validated">` を交差させ、parse の出力にだけ宿る phantom タグになる。
const BrandedUserSchema = UserSchema.brand();
//   ^? { name: string; age: number } & z.$brand<"validated">
async function saveBranded(user) {
    console.log("[save*]  ", user.name);
}
{
    const raw = { name: "test", age: 30 };
    const validated = BrandedUserSchema.parse(raw); // unknown → BrandedUser
    await saveBranded(validated);
}
function _brandedTypeOnlyExamples() {
    // 構造的に一致するリテラルでも、brand が無いので弾かれる
    // @ts-expect-error  通常オブジェクトは BrandedUser ではない
    saveBranded({ name: "x", age: 1 });
}
void _brandedTypeOnlyExamples;
async function saveAndTag(user) {
    console.log("[save*]  ", user.name);
    return user;
}
async function notifySaved(user) {
    console.log("[notify*]", user.name);
}
{
    const raw = { name: "test", age: 30 };
    const validated = BrandedUserSchema.parse(raw); // zod が担当する段
    const saved = await saveAndTag(validated); //   ここから先は手書きの phantom pipeline
    await notifySaved(saved);
}
function _orderTypeOnlyExamples() {
    const raw = { name: "test", age: 30 };
    const validated = BrandedUserSchema.parse(raw);
    // @ts-expect-error  save を飛ばして notify (BrandedUser は SavedUser ではない)
    notifySaved(validated);
}
void _orderTypeOnlyExamples;
// -----------------------------------------------------------------------------
// 結論
// -----------------------------------------------------------------------------
//   - zod は「実行時バリデーション」を提供するライブラリ
//   - その内部実装は $ZodType<Output, Input> という phantom 型パイプライン
//     (= 本編 02 のパターンを一般化したもの)
//   - `z.infer<>` は phantom 出力型を取り出すユーティリティ
//   - `.parse()` は「unknown → phantom 付き型」への状態遷移
//   - `.brand()` は「構造的に同じ型」とのすり替えを禁じる明示タグ
//   - validate より先の段 (save / notify の順序) は zod の守備範囲外
//     → 02 の手書きブランド、または 03 の Type-State Pattern と組み合わせる
//
// 「ライブラリ提供物 = 機能、内側で動いている仕掛け = 型レベル状態遷移」という
// 構図そのものは、後続の usecases (例: drizzle / kysely / hono の context chain
// 等) でも繰り返し出てくる。
