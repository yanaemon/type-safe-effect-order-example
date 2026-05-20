// =============================================================================
// 02. Phantom Pipeline — 型に「ラベル」を貼る (一次回答)
// =============================================================================
//
// アイデア: 値の型に交差型で「この値は validate を通った」ラベルを貼る。
//   - クラスはそのまま、引数の型に "_state" を足すだけ
//   - 順序ミスは引数型の不一致でコンパイル時に止まる
//   - 型は erase されるのでランタイムコスト 0
//
// 限界:
//   - これは「状態管理」ではなく「ラベル付け」
//   - 「次に呼べるメソッド」を制限する仕組みはない (引数型で都度書くしかない)
//   - 値の流れに乗ってラベルが運ばれているだけで、振る舞いは集約されていない
// =============================================================================

type UserData = {
	name: string;
	age: number;
};

// Phantom Type の累積形。ブランドキーは値として存在しない (型だけ)。
// 注意: 同じキーを使う素直な書き方
//   type ValidatedUserData = UserData & { _state: "validated" };
//   type SavedUserData     = ValidatedUserData & { _state: "saved" };
// は _state の交差が "validated" & "saved" = never に潰れる。
// 累積させたいなら段ごとに別キーを足す (= 下のスタイル) が安全。
type ValidatedUserData = UserData & { readonly __validated: true };
type SavedUserData = ValidatedUserData & { readonly __saved: true };

class UserService {
	// null を返すことで「validate 失敗」を表現
	validate(input: UserData): ValidatedUserData | null {
		if (input.name.length === 0 || input.age < 0) return null;
		// ラベルを貼って返す。実体は同じオブジェクト
		return input as ValidatedUserData;
	}

	async save(input: ValidatedUserData): Promise<SavedUserData> {
		console.log("[save]   ", input.name);
		return input as SavedUserData;
	}

	async sendNotification(input: SavedUserData): Promise<void> {
		console.log("[notify] ", input.name);
	}
}

const input: UserData = { name: "test", age: 30 };
const s = new UserService();

// ----- ✅ 正しい順序: validate → save → sendNotification ---------------------
const validated = s.validate(input);
if (validated) {
	const saved = await s.save(validated);
	await s.sendNotification(saved);
}

// ----- ❌ 順序ミスはコンパイル時に止まる -------------------------------------
// 実行しないので関数に閉じ込める。型チェックのみで意図したエラーが出るかを確認する。
function _typeOnlyExamples() {
	// @ts-expect-error  validate をスキップ (UserData は ValidatedUserData ではない)
	s.save(input);

	// @ts-expect-error  save をスキップ (ValidatedUserData は SavedUserData ではない)
	s.sendNotification(validated!);
}
void _typeOnlyExamples;

// 結論:
//   ✅ ランタイムコスト 0 (型は erase される)
//   ✅ シグネチャに意図が出る
//   ✅ 順序ミスをコンパイル時に止められる
//   ✅ ライブラリ不要、明日から導入可能
//   …しかし「状態 × 振る舞い」が同居していない。
//   ラベルを貼っているだけで、メソッドの集合は class に一括で生えている。
//   → 03-type-state-pattern.ts で「状態に応じた振る舞い」を扱う
