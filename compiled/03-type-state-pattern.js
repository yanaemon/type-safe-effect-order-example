// =============================================================================
// 03. Type-State Pattern — クラスの 型パラメータ に状態を持たせる (本旨)
// =============================================================================
//
// アイデア: 状態 × 振る舞いを「箱」 (= class) に集めて、状態をクラスの
// 型パラメータで持つ。`this:` 制約で「今呼べるメソッド」を絞る。
//
// 効くポイント:
//   - 状態 × 振る舞いが同じオブジェクトに乗る
//   - IDE 補完が「今呼べるメソッドだけ」を出す
//   - dispatcher は JS のメソッド呼び出しが担う → ライブラリ不要、runtime ゼロ
//   - phantom field "_state" は declare で宣言 → JS には emit されない
// =============================================================================
class UserDataProcessor {
    data;
    constructor(data) {
        this.data = data;
    }
    // this の型で「呼び出し可能な状態」を制約する。
    // 戻り値の型で「呼び出し後の状態」を表現する。
    validate() {
        if (this.data.name.length === 0 || this.data.age < 0)
            return null;
        return new UserDataProcessor(this.data);
    }
    async save() {
        console.log("[save]   ", this.data.name);
        return new UserDataProcessor(this.data);
    }
    async sendNotification() {
        console.log("[notify] ", this.data.name);
    }
}
const input = { name: "test", age: 30 };
// ----- ✅ 正しい順序: 状態を進めながら await で繋ぐ ---------------------------
const p = new UserDataProcessor(input);
const validated = p.validate();
if (validated) {
    const saved = await validated.save();
    await saved.sendNotification();
}
// ----- ❌ 順序ミスは this 制約で止まる ---------------------------------------
async function _typeOnlyExamples() {
    // @ts-expect-error  validate をスキップ (this は UserDataProcessor<"draft">)
    await p.save();
    // @ts-expect-error  save をスキップ
    await p.validate().sendNotification();
}
void _typeOnlyExamples;
export {};
// 結論:
//   - 値の型に貼っていたラベルが、クラスの型パラメータに昇格した
//   - 「状態」と「その状態で呼べる振る舞い」が同じ箱に同居
//   - dispatcher は JS のメソッド呼び出しが担う (型の世界で完結)
//
// 業界で "型が賢い" と感じるライブラリの中身もこれと同じで、
// メソッド chain ごとに型パラメータが進んで「次に呼べる API」を絞り込んでいる:
//   - Query Builder: chain の各段で状態を進める (from → select → execute)
//   - API クライアントの context chain: 認証や middleware の有無を型で持つ
//   - DB / Cache driver: Connection の接続状態を型パラメータで表現
//
// この方式の限界:
//   `this:` 制約は「呼ぶと型エラー」止まりで、IDE 補完にはメソッドが出る。
//   補完からも消したい (= そもそも呼べなくしたい) なら:
//   → 04-type-state-interface-hide.ts (Kysely / Drizzle 流: interface + Omit)
//
// 次: 04-type-state-interface-hide.ts で interface ベースの hide を見る
