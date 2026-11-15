# Satoshi pixel assets v1

OP selected **8-bit** as the product art direction. The colorful 3D boards were exploratory and are not production assets.

## Committed files

`public/satoshi/` contains the original transparent 48×48 neutral, joyful, and rowdy masters from Bitcoin’s standalone `ratel-satoshi-assets-v1` handoff. These master files are served directly; CSS displays them at integer multiples with `image-rendering: pixelated` (288px desktop, 240px mobile). No smoothing, rotation, saturation filter, baked food, baked shadow, merchant mark, or required animation is applied to the sprite pixels.

Native SHA-256 values, independently checked after downloading the handoff ZIP:

| State | Asset | SHA-256 |
|---|---|---|
| neutral | `satoshi-neutral-48.png` | `aaa03b0c1d09ef2eca02d564bb14a818ffa972535f9f10c354b07cad3ec180bb` |
| joyful | `satoshi-joyful-48.png` | `20039cfd978bf7d20df87316e38858ab60004b76049b0a641819fbdae0ae59ed` |
| rowdy | `satoshi-rowdy-48.png` | `e848c35e23f82bb543791cccb3077a2bf29b6937c87edaeb6e7450f98bf47752` |

Bundle SHA-256: `1b9cb4a0a8d4e606b91054c7d79b7d8d426a448d6d0e0b469625eef23aa073b5`.

Source/handoff: [OP’s direction](buzz://message?channel=342b50ca-6f04-4bdf-8618-ccffa29f5542&id=898070ac5829f33b9a4d3dd60413231fb8ce99c267e413cb395459950d362417), [Bitcoin’s asset delivery](buzz://message?channel=342b50ca-6f04-4bdf-8618-ccffa29f5542&id=2042385ff94e4f1107492990cd7b530057a379612074e0b19a199427cdb2ace9).

## Browser state selection

The client uses exactly this precedence:

1. **Rowdy** whenever `pet.stage === "rowdy"`, including when fullness later decays to hungry or joy changes.
2. **Joyful** for a cub with `pet.mood === "joyful"`.
3. **Neutral** for all remaining cub states, including hungry/content and no initial meal.

Food remains a separate den layer. The sprite changes only when committed world state selects a different asset. Browser tests exercise neutral on initial load, joyful after both an HTTP action and an SSE-delivered visitor action, and rowdy after twelve connected blocks.

## Scope and verification

The handoff’s 13 production PNGs passed independent dimension, hard-alpha, transparent-border, and exact nearest-neighbor export checks. The committed three master hashes above are verified against that downloaded bundle.

This is a browser art integration only. It does not establish watch-size readability, hardware appearance, firmware readiness, or any wrist behavior. Those remain separate **needs wrist test** claims if a BWATCH face is ever built.
