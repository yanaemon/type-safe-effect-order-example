# Type Safe Effect Order Example

TSKaigi 2026「TypeScript の型で副作用の実行順序を制御する」の補助例コード。
スライドで出てきた各概念を、独立した小さなファイルで動かせる形にまとめている。

## Layout

```
src/
├── 01-..05-...ts          ← 本編 (この順で読む)
└── libraries/             ← 特定ライブラリでの実装例 (読み順は任意)
    └── effect.ts
compiled/                  ← tsc 出力。src と同じ階層で .js が出る
tsconfig.json              ← rootDir=src, outDir=compiled
```

`src/` の各ファイルと `compiled/` の同名 `.js` を `diff` すると、型注釈・
`declare private readonly _state: S` などが綺麗に消えることが確認できる。
スライドの「ランタイムコスト 0 (型は erase される)」の物的証拠。

## Files

### 本編 (順番に読む)

| # | ファイル | 主題 |
|---|---|---|
| 01 | `src/01-problem.ts` | 問題提起。引数が同じ型なら TS は順序ミスを通してしまう |
| 02 | `src/02-phantom-pipeline.ts` | 一次回答: Phantom Pipeline (値の型に「ラベル」を貼る) |
| 03 | `src/03-type-state-pattern.ts` | 本旨: Type-State Pattern (クラスの型パラメータ + `this:` 制約) |
| 04 | `src/04-type-state-interface-hide.ts` | 発展: interface + Omit で IDE 補完からも消す |
| 05 | `src/05-runtime-fsm-limitation.ts` | 値ベース FSM と Type-State の比較。dispatcher の正体 |

### libraries/ — 特定ライブラリでの実装例

| ライブラリ | ファイル | 主題 |
|---|---|---|
| Effect.ts      | `src/libraries/effect.ts`         | エフェクトを値として扱う流派。順序は型ではなくデータ依存で表現 |
| xstate         | `src/libraries/xstate.ts`         | runtime の状態機械で順序を守る流派。不正遷移は no-op |
| typestate      | `src/libraries/typestate.ts`      | 軽量 runtime FSM。不正遷移は throw (xstate の no-op と対照的) |
| ts-checked-fsm | `src/libraries/ts-checked-fsm.ts` | FSM 定義そのものを compile-time で検証する。runtime dispatch は no-op |

各ファイルには `@ts-expect-error` 付きの「これは型エラーになる」例も入っている。
`pnpm typecheck` (or `npm run typecheck`) すれば、`@ts-expect-error` がちゃんと
エラーを抑えていること = エラーが起きていることが確認できる。

## Run

```bash
pnpm install        # or npm install / yarn

pnpm typecheck      # tsc --noEmit。@ts-expect-error が想定通りエラーを捕まえているか
pnpm build          # compiled/ に .js を出力

pnpm run:01         # 01-problem.ts を実行 (壊れた呼び出し例も含む)
pnpm run:02         # 02-phantom-pipeline.ts
pnpm run:03         # 03-type-state-pattern.ts
pnpm run:04         # 04-type-state-interface-hide.ts
pnpm run:05         # 05-runtime-fsm-limitation.ts

pnpm run:lib:effect         # libraries/effect.ts
pnpm run:lib:xstate         # libraries/xstate.ts
pnpm run:lib:typestate      # libraries/typestate.ts
pnpm run:lib:ts-checked-fsm # libraries/ts-checked-fsm.ts

pnpm diff:03        # src vs compiled の diff。型が erase される様子
```

## 読み順

1. `01-problem.ts` — 何が困るのか
2. `02-phantom-pipeline.ts` — 値の型にラベルを貼る一次回答と、その限界
3. `03-type-state-pattern.ts` — 状態 × 振る舞いをクラスに集約する本旨 (`this:` 制約)
4. `04-type-state-interface-hide.ts` — interface + Omit で補完からも消す
5. `05-runtime-fsm-limitation.ts` — 型だけで dispatcher を作れるか？の答え

## スライドの結論 (要約)

- 「副作用の順序ミスを型で止めたい」は **状態管理** の問題
- 型タグは「状態管理」ではなく「ラベル付け」
- 状態を扱うなら、状態 × 振る舞いを「箱」に集めるのが本来形
- **Type-State Pattern (Class) は TS 型だけで成立** — ライブラリ不要で軽い
- 本格的な状態機械なら xstate などの runtime 道もある (別レイヤー)
