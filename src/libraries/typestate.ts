// =============================================================================
// typestate — 軽量な runtime FSM ライブラリ
// =============================================================================
//
// (注意: ライブラリ名 "typestate" は紛らわしいが、本編 03 で扱った
//  Type-State "Pattern" とは別物。eonarheim/TypeState は runtime FSM の小さな
//  ライブラリ。ここでは慣例に従って "typestate" 表記で参照する。)
//
// xstate と同じ「runtime で状態遷移表を持つ」流派だが、より小さい:
//   - parallel / hierarchical / history なし
//   - actor / invoke なし (async は外で await して go() を呼ぶ)
//   - API は from(A).to(B) / canGo / go の 3 つが基本
//
// xstate との実用上の最大の差:
//   - xstate: 不正イベントは 黙って no-op (state は変わらない)
//   - typestate: 不正な go() は 例外を throw する
//   → 早く気付ける反面、try/catch を意識する必要がある
//
// Type-State Pattern (compile-time) との対比は引き続き同じで、
// typestate もあくまで runtime で順序を守るアプローチ。
// =============================================================================

import { TypeState } from "typestate";

type UserData = {
    name: string;
    age: number;
};

// 状態は enum (typestate は enum 値の === 比較で遷移を見る)
enum UserState {
    Draft,
    Validated,
    Saved,
    Notified,
}

// -----------------------------------------------------------------------------
// 遷移表を declare する小ヘルパー (毎回同じセットアップを使い回すため)
// -----------------------------------------------------------------------------

function createFsm(): TypeState.FiniteStateMachine<UserState> {
    const fsm = new TypeState.FiniteStateMachine<UserState>(UserState.Draft);
    fsm.from(UserState.Draft).to(UserState.Validated);
    fsm.from(UserState.Validated).to(UserState.Saved);
    fsm.from(UserState.Saved).to(UserState.Notified);
    return fsm;
}

// -----------------------------------------------------------------------------
// 副作用 (async)
// -----------------------------------------------------------------------------

async function save(input: UserData): Promise<void> {
    console.log("[save]   ", input.name);
}

async function notify(input: UserData): Promise<void> {
    console.log("[notify] ", input.name);
}

// -----------------------------------------------------------------------------
// ✅ 正しい順序: 各 step の後に go() で状態を進める
// -----------------------------------------------------------------------------

console.log("--- happy path ---");

{
    const input: UserData = { name: "test", age: 30 };
    const fsm = createFsm();

    // validate は同期チェック → go(Validated)
    console.log("[validate]", input.name);
    if (!(input.name.length === 0 || input.age < 0)) {
        fsm.go(UserState.Validated);
    }

    // 副作用は外で await し、終わったら go() で状態を進める
    await save(input);
    fsm.go(UserState.Saved);

    await notify(input);
    fsm.go(UserState.Notified);

    console.log("[done]   ", UserState[fsm.currentState]);
}

// -----------------------------------------------------------------------------
// 🚨 不正な順序: typestate は throw する (xstate の no-op とは違う)
// -----------------------------------------------------------------------------

console.log("--- wrong order throws ---");

{
    const fsm = createFsm();
    // 現在は Draft。Draft -> Saved の遷移は宣言されていない
    try {
        fsm.go(UserState.Saved);
    } catch (e) {
        console.log("[throw]  ", e instanceof Error ? e.message : String(e));
    }
    console.log("[state]  ", UserState[fsm.currentState]); // "Draft" のまま
}

// -----------------------------------------------------------------------------
// 🛡 canGo で事前にチェック (throw を避けたい場合)
// -----------------------------------------------------------------------------

console.log("--- canGo guard ---");

{
    const fsm = createFsm();
    console.log("Draft -> Saved 可能?", fsm.canGo(UserState.Saved)); // false
    console.log("Draft -> Validated 可能?", fsm.canGo(UserState.Validated)); // true

    if (fsm.canGo(UserState.Saved)) {
        fsm.go(UserState.Saved);
    } else {
        console.log("[skip]   Draft からは Saved に行けないので no-op");
    }
}

// -----------------------------------------------------------------------------
// 結論:
//   - typestate は xstate より小さく、純粋な「遷移表だけ持つ FSM」
//   - 不正遷移は throw → 早期検知できるが、呼び出し側で try/catch or canGo
//   - 「軽量に runtime FSM だけ欲しい」用途には fit
//   - parallel / hierarchical / actor が要るなら xstate
//   - そもそも順序ミスを compile-time で止めたいなら Type-State Pattern (本編 03)
// -----------------------------------------------------------------------------
