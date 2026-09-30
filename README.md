# @snoutdata/client

Part of [snoutdata/snoutdata](https://github.com/snoutdata/snoutdata), where the docs and examples live.

The JavaScript client for SnoutData Cloud. One project's data API, auth, storage, realtime,
Snout Functions and push notifications, from its URL and one key. No dependencies; runs in every browser and
in Node 22+.

```js
import { createClient } from '@snoutdata/client'

const db = createClient('https://<ref>.api.snoutdata.com', '<your anon key>')

const { data, error } = await db.from('todos').select('id, note').eq('done', false)
await db.auth.signInWithPassword({ email, password })
await db.storage.from('documents').upload('invoices/7.pdf', file)
db.channel('room:42').on('broadcast', { event: 'cursor' }, (m) => draw(m.payload)).subscribe()
await db.functions.invoke('hello', { body: { name: 'Ada' } })
await db.push.register({ transport: 'apns', token: deviceToken })
```

The method names and result shapes are the widely used v2 client API for a Postgres backend
(`from().select()`, `auth.signInWithPassword`, `storage.from().upload`, `channel().on()`,
`functions.invoke`), so an application written against that API moves over by changing the
import.

`db.push` is ours, with nothing to match: notifications to iPhone, Android and the web
(`register`, `subscribeWeb`, `send`, topics, receipts). See
[Push notifications](https://docs.snoutdata.com/cloud/push).

## Developing

```bash
npm install
npm test          # builds, then runs the unit tests (fake fetch, fake Phoenix socket)
```

The live proof is the compatibility harness, run through this client:

```bash
npm run build
bash apps/cloud/compat/compat.sh --yes --ref <ref> --client snoutdata
```

## Licence

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE). Version 0.1.0 was published under MIT
and stays MIT for anyone who has it; later versions are Apache-2.0.
