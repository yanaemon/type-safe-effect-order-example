// =============================================================================
// 04. Type-State Pattern (interface API 版) — メソッドを IDE 補完からも消す
// =============================================================================
//
// 03-type-state-pattern.ts は `this:` 制約で「呼ぶと型エラー」までは作れたが、
// IDE 補完にはまだメソッドが出てしまう (= 呼べないのに見えてしまう)。
//
// 解決: 実装は class、API として出す戻り値の型は interface にする。
// interface 上で `Omit` すれば、private フィールドを巻き込まずに
// 「その状態で呼べるメソッドだけ」を型に残せる (= 補完にも出ない)。
//
// 効くポイント:
//   - メソッドそのものが型から消える → 補完にも出ない
//   - 実体は同じインスタンスで OK (`return this`) → ランタイム コスト ゼロ
//   - `private constructor` + `static create(): Draft` で初期状態を強制
//   - 03 の phantom field / 型パラメータ default が不要になる
// =============================================================================
class UserService {
    data;
    // new で直接作らせない: create() 経由でしか入れない
    constructor(data) {
        this.data = data;
    }
    // 初期状態は Draft のみ公開 (validate しか呼べない)
    static create(data) {
        return new UserService(data);
    }
    validate() {
        if (this.data.name.length === 0 || this.data.age < 0)
            return null;
        return this; // 実体は同じ。型だけ次の状態に進める
    }
    async save() {
        console.log("[save]   ", this.data.name);
        return this;
    }
    async notify() {
        console.log("[notify] ", this.data.name);
    }
}
const input = { name: "test", age: 30 };
// ----- ✅ 正しい順序: 状態を進めながら await で繋ぐ ---------------------------
const p = UserService.create(input);
const validated = p.validate();
if (validated) {
    const saved = await validated.save();
    await saved.notify();
}
// ----- ❌ 順序ミスは「型から消えている」のでそもそも補完に出ない -------------
async function _typeOnlyExamples() {
    // @ts-expect-error  Draft には save が無い (型から消えている)
    await p.save();
    // @ts-expect-error  Validated には notify が無い
    await p.validate().notify();
    const v = p.validate();
    const s = await v.save();
    // @ts-expect-error  Saved には save が無い
    await s.save();
}
void _typeOnlyExamples;
export {};
// 結論:
//   - 「実装 = class、API = interface」と分けると、Omit で状態を絞れる
//   - private フィールドが interface 越しに見えないので、Omit が壊れない
//   - 03 (this: 制約) は呼ぶと型エラー、04 (interface 版) は補完にも出ない
//     → 厳しさで言うと interface 版の方が強い
