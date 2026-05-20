// =============================================================================
// xstate — runtime で状態機械として順序を守る
// =============================================================================
//
// xstate はトークでの位置づけ的には「本格的な状態機械が要るときの runtime 道」。
// Type-State Pattern が compile-time で「次に呼べるメソッド」を絞るのに対し、
// xstate は runtime に状態と遷移表を持ち、許されない遷移は「黙って無視」する
// (= 何も起きない / その状態に留まる)。
//
// 比較ポイント:
//   - Type-State Pattern: 不正な順序は コンパイルエラー → 出荷前に止まる
//   - xstate           : 不正な順序は runtime で no-op → ログや devtools で確認
//
// xstate を選ぶ理由は「単に順序を守りたい」より深いところにある:
//   - 並列状態 (parallel) / 階層状態 (hierarchical)
//   - 履歴状態 (history)
//   - 状態と遷移を「データ」として持つ → 可視化 / DevTools / Inspector
//   - actor model で並行・非同期処理を構造化
//
// このファイルでは validate → save → notify を xstate v5 で組み、
// 「runtime で不正遷移が止まる」様子を最後に実演する。
// =============================================================================
import { createActor, fromPromise, setup, waitFor } from "xstate";
// -----------------------------------------------------------------------------
// マシン定義: setup() で context / events / actors / guards の型を先に固める
// -----------------------------------------------------------------------------
const userMachine = setup({
    types: {
        context: {},
        input: {},
        events: {},
    },
    actors: {
        // 副作用は actor として切り出す。fromPromise で async 関数を載せる
        saveActor: fromPromise(async ({ input }) => {
            console.log("[save]   ", input.name);
            return input;
        }),
        notifyActor: fromPromise(async ({ input }) => {
            console.log("[notify] ", input.name);
        }),
    },
    guards: {
        isValid: ({ context }) => context.input.name.length > 0 && context.input.age >= 0,
    },
}).createMachine({
    initial: "draft",
    context: ({ input }) => ({ input }),
    states: {
        // draft からは VALIDATE しか受け付けない
        draft: {
            on: {
                VALIDATE: [
                    { target: "validated", guard: "isValid" },
                    { target: "invalid" },
                ],
            },
        },
        // validated からは SAVE しか受け付けない
        validated: {
            on: { SAVE: { target: "saving" } },
        },
        // saving は actor を invoke。完了で saved、失敗で failed へ
        saving: {
            invoke: {
                src: "saveActor",
                input: ({ context }) => context.input,
                onDone: { target: "saved" },
                onError: { target: "failed" },
            },
        },
        // saved からは NOTIFY しか受け付けない
        saved: {
            on: { NOTIFY: { target: "notifying" } },
        },
        notifying: {
            invoke: {
                src: "notifyActor",
                input: ({ context }) => context.input,
                onDone: { target: "notified" },
                onError: { target: "failed" },
            },
        },
        // final 状態: ここに来たらマシン終了
        notified: { type: "final" },
        invalid: { type: "final" },
        failed: { type: "final" },
    },
});
// -----------------------------------------------------------------------------
// ✅ 正しい順序: 状態が進むのを待ちながらイベントを送る
// -----------------------------------------------------------------------------
console.log("--- happy path ---");
const happy = createActor(userMachine, { input: { name: "test", age: 30 } });
happy.start();
happy.send({ type: "VALIDATE" });
await waitFor(happy, (s) => s.matches("validated"));
happy.send({ type: "SAVE" });
await waitFor(happy, (s) => s.matches("saved"));
happy.send({ type: "NOTIFY" });
await waitFor(happy, (s) => s.matches("notified"));
console.log("[done]   ", happy.getSnapshot().value); // "notified"
// -----------------------------------------------------------------------------
// ✋ guard で弾かれるケース: validate に失敗 → invalid 終了
// -----------------------------------------------------------------------------
console.log("--- guard failure ---");
const bad = createActor(userMachine, { input: { name: "", age: 30 } });
bad.start();
bad.send({ type: "VALIDATE" });
await waitFor(bad, (s) => s.matches("invalid"));
console.log("[exit]   ", bad.getSnapshot().value); // "invalid"
// -----------------------------------------------------------------------------
// 🚨 不正な順序: 「draft 状態で SAVE」は runtime で黙って no-op
// -----------------------------------------------------------------------------
// Type-State Pattern なら「コンパイルエラー」だったところが、xstate では
// 「現在の state で受け付けないイベント」として 黙って捨てられる だけ。
// 開発時に気付くには Inspector / devtools / ログを見る必要がある。
console.log("--- wrong event silently ignored ---");
const wrong = createActor(userMachine, { input: { name: "test", age: 30 } });
wrong.start();
console.log("before:", wrong.getSnapshot().value); // "draft"
wrong.send({ type: "SAVE" }); // draft では SAVE を受け付けない
console.log("after :", wrong.getSnapshot().value); // "draft" のまま (no-op)
// -----------------------------------------------------------------------------
// 結論:
//   - xstate は「順序ミスを止める」だけが目的なら overkill。
//     代わりに 並列 / 階層 / 履歴 / 可視化 / actor model を得る。
//   - 不正遷移は コンパイル時 ではなく runtime で no-op として現れる。
//     → Type-State Pattern (compile-time) と完全に別レイヤー。
//   - 「UI フロー」「ワークフローエンジン」「複雑な状態管理」のように
//     "状態と遷移をデータとして扱いたい" 場合に光る。
// -----------------------------------------------------------------------------
