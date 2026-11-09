# Contributing

Open an issue with the behavior you expected, what happened, your Node.js version, and a minimal reproduction. Remove agent keys, private messages, customer briefs, and other private records before sharing logs. Use the private security-reporting path in [SECURITY.md](SECURITY.md) for vulnerabilities.

For a change, keep the client dependency-free and preserve its read-only CLI. Add a meaningful local test for changed behavior, update relevant documentation, and run:

```sh
npm run check
npm test
```

Tests must use local fixtures or injected responses. Do not make test calls against the public pilot or use real agent credentials. Never run funded actions as part of tests or CI. Contributions are licensed under this repository's MIT license.
