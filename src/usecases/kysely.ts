// =============================================================================
// usecases/kysely — 「型安全な SQL クエリビルダー」を提供するライブラリ
//                                            (内部実装: Type-State Pattern (builder))
// =============================================================================
//
// usecases 第二弾。zod が「実行時バリデーション」を提供する裏で
// 02-phantom-pipeline.ts と同じ phantom 型を使っていたのに対し、
// Kysely は「SQL を書くと TS の型がついてくる」という機能を提供する裏で
// 03-type-state-pattern.ts と同じ流儀 ── チェインで型パラメータを進化させる
// builder 型 type-state ── を駆使している。
//
// ─── Kysely の内部で何が起きているか ─────────────────────────────────────────
//
//   interface SelectQueryBuilder<DB, TB extends keyof DB, O> { ... }
//   class    InsertQueryBuilder<DB, TB extends keyof DB, O>  { ... }
//
//   - DB : データベース全体のスキーマ (テーブル名 → 行型 のマップ)
//   - TB : 「今このクエリで参照中のテーブル」 (DB のキーの集合)
//   - O  : 「最終的に返す行型」(SELECT で蓄積、INSERT は returning で蓄積)
//
//   チェインメソッドは type-state の `this:` 制約と同じ役割で
//   「TB / O を進化させた新しい型」を返す:
//
//     db.selectFrom('user')                  : SelectQueryBuilder<DB, 'user', {}>
//       .innerJoin('post', ...)              : SelectQueryBuilder<DB, 'user'|'post', {}>
//       .select(['user.name', 'post.title']) : SelectQueryBuilder<DB, ..., { name; title }>
//       .where('user.age', '>', 18)          : 同じ TB/O (where は型を進めない)
//       .execute()                           : Promise<O[]>
//
//   = 03 の `class UserService<S>` で `S` が draft → validated → saved と
//   遷移していたのと同じ仕掛けが、「TB / O」という 2 次元で起こっている。
//
// このファイルでは:
//   1) DB スキーマを宣言して Kysely の入口を作る
//   2) SELECT チェインで TB / O が進化する様子を inspector で見る
//   3) 存在しないカラム / 未 join のテーブル参照が @ts-expect-error で止まることを確認
//   4) INSERT を使って validate → save の流れに乗せ、compile() で SQL を見る
//
// 実行は `.compile()` で SQL 文字列を取り出すだけにとどめている (ネイティブ依存なし)。
// =============================================================================

import {
    DummyDriver,
    type Generated,
    Kysely,
    PostgresAdapter,
    PostgresIntrospector,
    PostgresQueryCompiler,
} from "kysely";

// -----------------------------------------------------------------------------
// 1) DB スキーマ宣言 (= Kysely の "Database 型")
// -----------------------------------------------------------------------------
//
// `Generated<T>` は「INSERT 時には任意、SELECT 時には必ず T」という Kysely の
// マーカー型。これを付けないと INSERT 側の values() で id が必須扱いになる。

interface UserTable {
    id: Generated<number>;
    name: string;
    age: number;
}

interface PostTable {
    id: Generated<number>;
    user_id: number;
    title: string;
}

interface DB {
    user: UserTable;
    post: PostTable;
}

// driver は SQL 生成だけ担当するダミー (実行はしない)
const db = new Kysely<DB>({
    dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => new DummyDriver(),
        createIntrospector: (kdb) => new PostgresIntrospector(kdb),
        createQueryCompiler: () => new PostgresQueryCompiler(),
    },
});

// -----------------------------------------------------------------------------
// 2) チェイン = 型パラメータの進化 (= 03 と同じ Type-State Pattern)
// -----------------------------------------------------------------------------
//
// 各 step で SelectQueryBuilder の <DB, TB, O> がどう動くかを inspector 型で
// メモしてある (hover で `_check` の型を見ると追いかけられる)。

const step1 = db.selectFrom("user");
//    ^? SelectQueryBuilder<DB, 'user', {}>
//                              ↑ TB に 'user' が入った

const step2 = step1.select(["user.name", "user.age"]);
//    ^? SelectQueryBuilder<DB, 'user', { name: string; age: number }>
//                                       ↑ O に列の型が蓄積された

const step3 = step2.innerJoin("post", "post.user_id", "user.id");
//    ^? SelectQueryBuilder<DB, 'user' | 'post', { name; age }>
//                              ↑ TB に 'post' が追加され、post.* が参照可能になる

const step4 = step3.select("post.title");
//    ^? SelectQueryBuilder<DB, 'user' | 'post', { name; age; title }>

// inspector 型: TB / O の中身を意図通り更新できているかを compile time で確認
type _Step1OK = AssertEq<SelectTBOf<typeof step1>, "user">;
type _Step2OK = AssertEq<SelectOOf<typeof step2>, { name: string; age: number }>;
type _Step3OK = AssertEq<SelectTBOf<typeof step3>, "user" | "post">;

// (この型ヘルパは Kysely の内部型を覗く都合で書いている。本筋ではない)
type SelectTBOf<T> = T extends { __select_tb__?: infer X }
    ? X
    : // フォールバック: 実装側に __select_tb__ は無いので別経路で推論
      InferTB<T>;
type SelectOOf<T> = T extends { __select_o__?: infer X } ? X : InferO<T>;
// 実体は SelectQueryBuilder<DB, TB, O> の型引数を取り出すだけ
// (SelectQueryBuilder の第 2 型パラメータは `extends keyof DB` 制約付きなので、
//  infer 側にも `extends keyof DB` を書いておく必要がある)
type InferTB<T> = T extends import("kysely").SelectQueryBuilder<
    DB,
    infer TB extends keyof DB,
    infer _O
>
    ? TB
    : never;
type InferO<T> = T extends import("kysely").SelectQueryBuilder<
    DB,
    infer _TB extends keyof DB,
    infer O
>
    ? O
    : never;
type AssertEq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// -----------------------------------------------------------------------------
// 3) 不正な参照は compile-time で止まる (= type-state の御利益)
// -----------------------------------------------------------------------------

function _typeOnlyExamples() {
    // @ts-expect-error  'user.foo' は UserTable に存在しない
    db.selectFrom("user").select(["user.foo"]);

    // @ts-expect-error  まだ join していない 'post' を参照
    db.selectFrom("user").select(["post.title"]);

    // @ts-expect-error  存在しないテーブル
    db.selectFrom("unknown_table");
}
void _typeOnlyExamples;

// -----------------------------------------------------------------------------
// 4) validate → save (INSERT) の流れ
// -----------------------------------------------------------------------------
//
// validate は前章 (zod) と同じく phantom 型で表現してもよいが、
// ここでは Kysely 側の InsertQueryBuilder の型遷移を主役にしたいので、
// validate は単純に「型が UserData」であることだけ要求する。

interface UserData {
    name: string;
    age: number;
}

async function save(input: UserData) {
    // db.insertInto('user')                  : InsertQueryBuilder<DB, 'user', InsertResult>
    //   .values({ name, age })               : 同じ (insert する行の shape は DB['user'] から推論)
    //   .returning(['id', 'name'])           : InsertQueryBuilder<DB, 'user', { id; name }>
    //   .compile()                           : CompiledQuery
    const query = db
        .insertInto("user")
        .values({ name: input.name, age: input.age })
        .returning(["id", "name"]);

    const compiled = query.compile();
    console.log("[save]   ", compiled.sql);
    console.log("[params] ", compiled.parameters);
    // 本番ならここで await query.execute() を呼ぶ
}

async function notify(input: UserData) {
    console.log("[notify] ", input.name);
}

// ----- 動かしてみる ----------------------------------------------------------
{
    const input: UserData = { name: "test", age: 30 };
    await save(input);
    await notify(input);
}

// ----- INSERT 側の型ガードも効く --------------------------------------------
function _insertTypeOnlyExamples() {
    // @ts-expect-error  必須カラム 'name' を渡していない
    db.insertInto("user").values({ age: 30 });

    // @ts-expect-error  'name' の型違い (string が要る)
    db.insertInto("user").values({ name: 123, age: 30 });

    // @ts-expect-error  存在しないカラムを returning
    db.insertInto("user").values({ name: "x", age: 1 }).returning(["foo"]);
}
void _insertTypeOnlyExamples;

// -----------------------------------------------------------------------------
// 結論
// -----------------------------------------------------------------------------
//   - Kysely は「型安全な SQL クエリビルダー」を提供するライブラリ
//   - その実装は SelectQueryBuilder<DB, TB, O> / InsertQueryBuilder<DB, TB, O> という
//     phantom 型パラメータ 3 つの type-state。チェインで TB / O が進化していく
//   - これは 03-type-state-pattern.ts の `class UserService<S>` で
//     `validate(this: UserService<"draft">): UserService<"validated">` と
//     書いていたのと完全に同じ仕掛け (state が 2 次元に増えただけ)
//   - 提供物 (= SQL の型安全) は機能、内部の状態遷移は本編で扱った型パターン、という
//     usecases の構図そのもの
//
// zod が phantom pipeline (02) を一般化して「バリデーション」を売り、
// Kysely が type-state pattern (03) を一般化して「型付きクエリ」を売る、と
// 並べて見ると、本編で扱った 2 種類のパターンが現実の OSS でそれぞれ
// 機能化されていることが分かる。
