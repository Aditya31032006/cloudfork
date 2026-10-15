# cloudfork

Fork your real AWS account into [Floci](https://github.com/floci-io/floci), the free, open-source local AWS
emulator. cloudfork scans your account with read-only credentials, saves its configuration to a snapshot
(`cloudfork.json`), and recreates it inside Floci as a local twin.

> **Status: early development.** S3 is supported today; DynamoDB and SQS are next.

```sh
npx cloudfork scan --profile prod      # read-only scan → cloudfork.json
npx cloudfork up                       # recreate it in Floci at http://localhost:4566
```

## Safety

cloudfork is built so that it cannot change your real AWS account.

- **Read-only source.** Attach [`iam/readonly-policy.json`](iam/readonly-policy.json) to the profile you scan
  with. On top of that, every client cloudfork creates for your account carries a guard that rejects any
  operation other than `List*`, `Get*` and `Describe*` before a request is sent. Reads that return secret
  values (`GetSecretValue`, `GetParameter`, …) are blocked too.
- **Writes only go to Floci.** The twin client refuses any endpoint under `amazonaws.com` (and other AWS
  domains), requires the endpoint to be set explicitly, re-checks the host of every outgoing request, and always
  uses fake per-account credentials, never yours.
- **No secret values, no data by default.** Only configuration is copied.
- **Your account ID stays out of the snapshot.** Account IDs inside ARNs, policies and names are replaced with
  placeholders. The snapshot's `sourceAccountId` is an HMAC-SHA256 of the account ID, keyed with a random salt
  that cloudfork creates on first run at `~/.config/cloudfork/salt` (override with `CLOUDFORK_CONFIG_DIR`).
  Your machine can tell which account a snapshot came from, but someone with only the snapshot file can't
  brute-force the ID: an unsalted hash of a 12-digit number could be reversed in minutes, an HMAC with a secret
  key can't. Keep the salt file out of your repo; if you lose it, old snapshots still work but can no longer be
  matched to their account.
- **Logs show resource names only**, never credentials, data values or raw AWS error messages.

## Development

```sh
npm install
npm test                 # unit + integration (starts Floci in Docker via testcontainers)
npm run test:unit        # no Docker needed
FLOCI_ENDPOINT=http://localhost:4566 npm run test:integration   # use an already-running Floci
```

## License

MIT
