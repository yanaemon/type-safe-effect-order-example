// =============================================================================
// 05. Runtime FSM Limitation — dispatcher も型だけで縛れる？
// =============================================================================
//
// 結論: 型だけでは不可能。
//   TS の型は compile-time に消える。実行時の state 値を読んで分岐するには
//   必ず runtime が必要。
//
// このファイルでは 2 つのアプローチを並べて、違いを目に見える形にする。
//   (A) 値ベース FSM      — 状態を値で保持し、明示的な dispatch(state, event) が要る
//   (B) Type-State Pattern — 状態を型で保持し、dispatch は JS のメソッド呼び出しが担う
// =============================================================================

// -----------------------------------------------------------------------------
// (A) 値ベース FSM
// 状態を runtime に持つ。dispatch(state, event) を自前で書く必要がある。
// (汎用の状態機械ライブラリがやっていることの最小版)
// -----------------------------------------------------------------------------

type DoorState = "closed" | "open" | "locked";
type DoorEvent = "OPEN" | "CLOSE" | "LOCK" | "UNLOCK";

// dispatch は runtime に存在する関数。型の世界では完結しない
function dispatchDoor(state: DoorState, event: DoorEvent): DoorState {
	switch (state) {
		case "closed":
			if (event === "OPEN") return "open";
			if (event === "LOCK") return "locked";
			return state;
		case "open":
			if (event === "CLOSE") return "closed";
			return state;
		case "locked":
			if (event === "UNLOCK") return "closed";
			return state;
	}
}

// 使う側は state 変数を管理し続けないといけない
{
	let state: DoorState = "closed";
	state = dispatchDoor(state, "OPEN"); // open
	state = dispatchDoor(state, "LOCK"); // open のままで反映されない (ランタイムで黙って無視)
	state = dispatchDoor(state, "CLOSE"); // closed
	state = dispatchDoor(state, "LOCK"); // locked
	console.log("[A] final =", state);
}

// 問題点:
//   - "open のときに LOCK を呼んでも何も起きない" がコンパイル時に分からない
//   - 不正な遷移は runtime まで気付けない
//   - state 変数の取り回しが利用側に漏れている

// -----------------------------------------------------------------------------
// (B) Type-State Pattern
// 状態を型で保持。不正な遷移はそもそも書けない (コンパイル時に止まる)。
// -----------------------------------------------------------------------------

class Door<S extends "closed" | "open" | "locked" = "closed"> {
	private declare readonly _state: S;
	private constructor() {}

	static create(): Door<"closed"> {
		return new Door<"closed">();
	}

	open(this: Door<"closed">): Door<"open"> {
		return new Door<"open">();
	}
	close(this: Door<"open">): Door<"closed"> {
		return new Door<"closed">();
	}
	lock(this: Door<"closed">): Door<"locked"> {
		return new Door<"locked">();
	}
	unlock(this: Door<"locked">): Door<"closed"> {
		return new Door<"closed">();
	}
}

{
	// ✅ closed -> open -> close -> lock -> unlock
	const final = Door.create().open().close().lock().unlock();
	console.log("[B] final =", final.constructor.name);
}

// ❌ 不正遷移はコンパイル時に止まる (型チェックだけ、実行しない)
function _typeOnlyExamples() {
	// @ts-expect-error  open のとき LOCK は呼べない
	Door.create().open().lock();

	// @ts-expect-error  locked のとき OPEN は呼べない
	Door.create().lock().open();
}
void _typeOnlyExamples;

// -----------------------------------------------------------------------------
// 設計判断のチェックリスト
// -----------------------------------------------------------------------------
//
//   値そのものの区別がしたい
//     → Phantom Type             (Email vs URL / UserId vs OrderId)
//
//   処理の順序ミスを止めたい (本筋)
//     → Type-State Pattern       (Builder / Connection / Form の段階)
//
//   本格的な状態機械が要る (並列状態 / 階層状態 など)
//     → runtime の状態機械ライブラリに任せる (別レイヤー)
//
//   副作用モデル全体を扱いたい (並行 / キャンセル / エラー型)
//     → エフェクト系ライブラリに任せる (解決レイヤーが違う)
//
// -----------------------------------------------------------------------------
// 「型は何を表すか」ではなく「状態をどこに置くか」が設計の本丸。
// -----------------------------------------------------------------------------
