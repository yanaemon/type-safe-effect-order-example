// =============================================================================
// 04. Type-State Pattern in the Wild — Query Builder 風
// =============================================================================
//
// 「賢く見えるライブラリ」の正体は、ほぼ Type-State Pattern。
// ここでは SQL Query Builder を最小実装で再現して、SELECT 系チェーンが
// どのように Type-State で守られているかを見る。
//
// 守りたい順序のルール:
//   - from() を呼ぶまで where()/select() できない
//   - select() を呼ぶまで execute() できない (列を決めないと SQL が組めない)
//   - where() は select() の前にしか書けない (簡略化のため)
// =============================================================================

type QueryFlags = {
	hasFrom: boolean;
	hasSelect: boolean;
};

type Empty = { hasFrom: false; hasSelect: false };
type Froms = { hasFrom: true; hasSelect: false };
type Ready = { hasFrom: true; hasSelect: true };

class QueryBuilder<F extends QueryFlags = Empty> {
	private declare readonly _flags: F;

	private constructor(
		private readonly parts: {
			table?: string;
			columns?: string[];
			where?: string;
		},
	) {}

	static create(): QueryBuilder<Empty> {
		return new QueryBuilder<Empty>({});
	}

	// from は Empty 状態でのみ呼べる
	from(this: QueryBuilder<Empty>, table: string): QueryBuilder<Froms> {
		return new QueryBuilder<Froms>({ ...this.parts, table });
	}

	// where は from 済みかつ select 前にだけ呼べる
	where(this: QueryBuilder<Froms>, expr: string): QueryBuilder<Froms> {
		return new QueryBuilder<Froms>({ ...this.parts, where: expr });
	}

	// select は from 済みのときだけ呼べる。呼ぶと Ready になる
	select(this: QueryBuilder<Froms>, ...columns: string[]): QueryBuilder<Ready> {
		return new QueryBuilder<Ready>({ ...this.parts, columns });
	}

	// execute は Ready (= from + select) でないと呼べない
	execute(this: QueryBuilder<Ready>): string {
		const { table, columns, where } = this.parts;
		const sql = `SELECT ${columns!.join(", ")} FROM ${table}${where ? ` WHERE ${where}` : ""}`;
		console.log("[sql]", sql);
		return sql;
	}
}

// ----- ✅ 正しいチェーン ----------------------------------------------------
QueryBuilder.create()
	.from("users")
	.where("age >= 18")
	.select("id", "email")
	.execute();

// ----- ❌ 順序ミスは型で止まる ----------------------------------------------
// この関数は実行しない。型チェックだけ通してエラーが「ちゃんとエラーになる」
// ことを確かめる用 (実行すると不正なクエリで runtime crash する)
function _typeOnlyExamples() {
	// @ts-expect-error  from なしで where は呼べない
	QueryBuilder.create().where("age >= 18");

	// @ts-expect-error  from なしで select は呼べない
	QueryBuilder.create().select("id");

	// @ts-expect-error  select 後に where は呼べない (Ready 状態には where がない)
	QueryBuilder.create().from("users").select("id").where("age >= 18");

	// @ts-expect-error  select せずに execute は呼べない
	QueryBuilder.create().from("users").execute();
}
void _typeOnlyExamples; // unused 警告除け

// 結論:
//   - 成熟した Query Builder の「気持ちよさ」の核はこれ
//   - 各 chain で型パラメータが進み、IDE 補完が次に呼べるメソッドだけを出す
//   - dispatcher は JS のメソッド呼び出しが担う → runtime に状態機械は要らない
