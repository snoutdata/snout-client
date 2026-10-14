# @snoutdata/client

Part of [snoutdata/snoutdata](https://github.com/snoutdata/snoutdata), where the docs and examples live.

The JavaScript client for SnoutData Cloud. One project's data API, auth, storage, realtime,
Snout Functions and push notifications, from its URL and one key. No dependencies; runs in every browser and
in Node 22+.

```js
import { snout } from '@snoutdata/client'

const db = snout('https://<ref>.api.snoutdata.com', '<your app key>')

const { data, error } = await db.from('todos').select('id, note').eq('done', false)
await db.identity.passwordSignIn({ email, password })
await db.files.space('documents').upload('invoices/7.pdf', file)
db.channel('room:42').listen('signal', { event: 'cursor' }, (m) => draw(m.payload)).subscribe()
await db.fn.call('hello', { body: { name: 'Ada' } })
await db.push.register({ transport: 'apns', token: deviceToken })
```

Every call resolves to `{ data, error }` rather than throwing, so a refusal from the database is a
value you can show. Queries are built by chaining (`from('todos').select().eq().order()`), and with
the types `snoutdata gen types typescript` writes, every row is typed from your own schema.

No bundler? The published files are plain ES modules, so a page can import them from a CDN, pinned
to an exact version:

```html
<script type="module">
  import { snout } from 'https://cdn.jsdelivr.net/npm/@snoutdata/client@0.3.4/dist/index.js'
</script>
```

`db.push` is ours, with nothing to match: notifications to iPhone, Android and the web
(`register`, `subscribeWeb`, `send`, topics, receipts). See
[Push notifications](https://docs.snoutdata.com/stack/push).

## Developing

```bash
npm install
npm test          # builds, then runs the unit tests (fake fetch, fake Phoenix socket)
```

Beyond the unit tests, a release that changes behaviour is run against a live SnoutData Cloud
project before it is published.

## Licence

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE). Version 0.1.0 was published under MIT
and stays MIT for anyone who has it; later versions are Apache-2.0.
