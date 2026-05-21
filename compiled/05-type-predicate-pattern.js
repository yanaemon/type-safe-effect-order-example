// =============================================================================
// 05. Type Predicate Pattern — runtime で確かめて、型レベルで narrow する
// =============================================================================
//
// 03 / 04 (Type-State) は「状態を型パラメータで持って、各メソッドが状態を
// 進める」設計だった。これは「現在の状態が compile-time で分かっている」
// 前提が成り立っているときに 100% 効く。
//
// しかし現実には:
//   - DB / JSON / queue から読んだ UserService の状態は実行時にしか分からない
//   - middleware を通った後の Request が "認証済み" かどうかは context 次第
//   - ある関数が「draft でも validated でも受け取る」必要がある
//
// このとき UserService<"draft" | "validated"> のような union 化した型に対して
// `save(this: UserService<"validated">)` は呼べない (draft が混じり得るから)。
// → runtime に状態を「確かめて」、型を narrow する道具が欲しい。
//
// TypeScript はこの目的のためだけに用意された 2 つの宣言を持っている:
//
//   1. `this is X`             : type predicate (戻り値の boolean が真なら narrow)
//   2. `asserts this is X`     : assertion function (例外が出なければ narrow)
//
// このファイルでは UserService<S> に両方を生やして、union 化した値を
// runtime 検査越しに「03 と同じ厳しい型」へ落とすところまでを見る。
// =============================================================================
class UserService {
    data;
    constructor(data) {
        this.data = data;
    }
    // -------------------------------------------------------------------------
    // 💡 技法 1: Type Predicate を method にする
    // -------------------------------------------------------------------------
    //
    // 戻り値型を `this is UserService<"validated">` にすると、
    //   - runtime: ただの boolean を返す関数
    //   - 型レベル: true 枝で `this` の型が UserService<"validated"> に narrow
    // という二重の意味を持つ。
    //
    // ポイントは「TS が真偽値を信じる」ところ。実装が嘘をついていても、
    // TS は narrow してしまう。 → 検査関数の中身は信頼境界。
    isValidated() {
        return this.data.name.length > 0 && this.data.age >= 0;
    }
    isSaved() {
        // 実装は何でもいい (例えば DB 上の保存フラグを見る、など)。
        // ここでは _state を直接読めない (private declare) ので、簡易ロジックで。
        return false;
    }
    // -------------------------------------------------------------------------
    // 💡 技法 2: Assertion Function を method にする
    // -------------------------------------------------------------------------
    //
    // 戻り値型を `asserts this is UserService<"validated">` にすると、
    //   - runtime: 条件が満たされないと throw する関数
    //   - 型レベル: 呼び出し後の行から `this` が UserService<"validated"> に narrow
    // という意味になる。
    //
    // if 文を書きたくない (= "ここから先は確実に validated" と言い切りたい) 場合は
    // assertion 版が便利。ただし「真偽値で分岐したい」場合は predicate を使う。
    assertValidated() {
        if (!this.isValidated()) {
            throw new Error("not validated");
        }
    }
    // 03 と同じ「呼び出せる状態」の制約。これらは型が validated/saved に
    // narrow されているときしか呼べない。
    async save() {
        console.log("[save]   ", this.data.name);
        return new UserService(this.data);
    }
    async notify() {
        console.log("[notify] ", this.data.name);
    }
}
// -----------------------------------------------------------------------------
// ユースケース 1: 状態が union な instance を narrow
// -----------------------------------------------------------------------------
//
// 「draft でも validated でも来る」関数で、validated だったときだけ進めたい。
// type predicate を if で使うと、then 枝の `s` が UserService<"validated"> に
// narrow される。
async function processIfValidated(s) {
    if (s.isValidated()) {
        // この行では s : UserService<"validated">  (union から narrow された)
        const saved = await s.save();
        await saved.notify();
    }
    else {
        console.log("[skip]   not validated");
    }
}
// -----------------------------------------------------------------------------
// ユースケース 2: assert で「ここから先は確実に validated」を宣言する
// -----------------------------------------------------------------------------
//
// 分岐したくない、validate されていなかったらそもそも続行不能、というケース。
// assertValidated() を呼んだ後の行では narrow が効いている。
async function processOrThrow(s) {
    s.assertValidated();
    // この行以降では s : UserService<"validated">
    const saved = await s.save();
    await saved.notify();
}
async function _externalSourceExample() {
    const s = loadFromAnywhere(); // UserService<"draft" | "validated" | "saved">
    if (s.isSaved()) {
        await s.notify(); // notify は this: UserService<"saved"> なので OK
        return;
    }
    if (s.isValidated()) {
        const saved = await s.save();
        await saved.notify();
        return;
    }
    console.log("[skip]   still draft");
}
void _externalSourceExample;
// -----------------------------------------------------------------------------
// 動かしてみる
// -----------------------------------------------------------------------------
const draft = new UserService({
    name: "test",
    age: 30,
});
await processIfValidated(draft);
await processOrThrow(draft);
// -----------------------------------------------------------------------------
// ❌ narrow なしで save を呼ぶと止まる
// -----------------------------------------------------------------------------
async function _typeOnlyExamples(s) {
    // @ts-expect-error  union のままでは save() の this: 制約に合わない
    await s.save();
    // ✅ predicate で narrow されたら呼べる
    // if (s.isValidated()) {
    //     await s.save();
    // }
    // ✅ assertion で narrow されたら呼べる
    s.assertValidated();
    await s.save();
}
void _typeOnlyExamples;
export {};
// -----------------------------------------------------------------------------
// 設計上の注意 — predicate / assertion は信頼境界
// -----------------------------------------------------------------------------
//
//   isValidated(): this is UserService<"validated"> {
//     return true; // ← 嘘でも TS は narrow してしまう
//   }
//
// 中身が真実を返す責任は「人間が読んで保証する」ところまで戻ってくる。
// 型のチェック範囲は narrow の入口で打ち切られている、と理解するのが正しい。
//
// 言い換えると:
//   - 03 / 04 (純 Type-State)  : 内側で完結。narrow の信頼境界は無い
//   - 05 (Type Predicate)      : runtime と型の橋を架ける。橋の上は信頼問題
//
// 「外の世界 (DB / JSON / unknown) から型の世界へ入る入口」では、
// この信頼境界を 1 か所にまとめて、内側は純粋 Type-State で守る、という
// 二段構えが現実的によく使われる。
//
// 次:
//   - 06-dispatcher-pattern.ts (旧 05): 状態を 値 として持つ FSM との対比
//   - 07-type-state-effect-hybrid.ts (旧 06): Type-State × Effect の合わせ技
//   - usecases/zod.ts: parse() が phantom 型を narrow させる外界の入口
// =============================================================================
