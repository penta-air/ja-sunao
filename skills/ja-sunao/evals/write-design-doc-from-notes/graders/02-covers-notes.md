---
type: llm
focus: trace
weight: 1
---

design.md に、5xxとタイムアウトのみリトライ、4xxはロックを避けるためリトライしない、最大3回、0.5s→1s→2s、ジッター、12月第2週目標がすべて入っている
