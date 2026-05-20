// =============================================================================
// 01. Problem — 副作用は順序が命。でも TS は通してしまう
// =============================================================================
//
// よくあるユーザー作成処理は ✅ 検証 → 💾 保存 → 🔔 通知 の順序が前提。
// しかし TS は引数の型が同じなら順番を入れ替えても通してしまう。
// → 気付くのはランタイム 😰
//
// このファイルは「壊れる例」を意図的に残しています。
// =============================================================================
class UserService {
    validate(input) {
        console.log("[validate]", input.name);
        return input.name.length > 0 && input.age >= 0;
    }
    save(input) {
        console.log("[save]   ", input.name);
        // 本番なら DB に書き込む
    }
    sendNotification(input) {
        console.log("[notify] ", input.name);
        // 本番なら通知を送る
    }
}
const input = { name: "test", age: 30 };
// ----- ✅ 正しい順序 ---------------------------------------------------------
{
    const s = new UserService();
    s.validate(input);
    s.save(input);
    s.sendNotification(input);
}
// ----- ❌ 順序ミス: TS は通してしまう ----------------------------------------
{
    const s = new UserService();
    // 意図的に順序を間違えた呼び出し。型エラーにならない。
    s.sendNotification(input); // 保存前に通知
    s.save(input); // バリデーション前に保存
    s.validate(input); // 最後にバリデーション (もう遅い)
}
export {};
// 結論:
//   - 引数の型は全部 UserData。区別がない → 順序の知識は人間任せ
//   - 「副作用が走ったかどうか」は状態。型に出ていない
//   - 次のステップ: 型で守る → 02-phantom-pipeline.ts へ
