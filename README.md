# NuGet Resilient Login

Authenticate to NuGet.org with GitHub OIDC, bounded retries, request timeouts, and masked credentials.

Exchanges a GitHub OIDC token for a short-lived NuGet.org API key. Supports
bounded retries, per-attempt timeouts, and secret masking without third-party
runtime dependencies. Runs on Linux, Windows, and macOS using Node.js 24.
GitHub's runner provides the action runtime; consumers do not need a setup-node
step. Like `NuGet/login`, only `user` is required. Self-hosted runners must support
Node 24 JavaScript actions; arbitrary operating systems are not supported.

## Usage

Create a [NuGet.org trusted publishing policy](https://learn.microsoft.com/nuget/nuget-org/trusted-publishing)
that matches your repository owner, repository, publishing workflow filename,
and optional GitHub environment. Set `user` to the policy creator's NuGet.org
username, including when publishing packages owned by an organization.

```yaml
permissions:
  contents: read
  id-token: write

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      # Build or download your .nupkg files before logging in.
      - uses: soenneker/nuget-resilient-login@v2
        id: login
        with:
          user: your-nuget-username
      - name: Push packages
        shell: bash
        env:
          NUGET_API_KEY: ${{ steps.login.outputs.NUGET_API_KEY }}
        run: dotnet nuget push 'artifacts/*.nupkg' --api-key "$NUGET_API_KEY" --source https://api.nuget.org/v3/index.json
```

Use a full commit SHA instead of a version tag when you need an immutable pin.
Log in immediately before publishing. The API key is a masked step output for
subsequent steps in the same job; it is not written to NuGet configuration.
The action defaults to NuGet.org and does not restore or push packages.

| Input | Default | Purpose |
| --- | --- | --- |
| `user` | Required | NuGet.org username of the policy creator |
| `token-service-url` | `https://www.nuget.org/api/v2/token` | HTTPS exchange endpoint, as in `NuGet/login` |
| `audience` | `https://www.nuget.org` | OIDC audience, as in `NuGet/login` |
| `max-retries` | `2` | NuGet retries, from 0 through 5; OIDC uses at most two |
| `timeout-seconds` | `60` | Initial NuGet attempt timeout, from 1 through 600 seconds; doubles on each retry up to 600 seconds |
| `log-responses` | `true` | Log sanitized error messages and selected diagnostic response headers |

The default attempt timeouts are 60, 120, and 240 seconds, including reading
response bodies. Setting `timeout-seconds` changes the initial timeout; subsequent
retries double it up to a ten-minute per-attempt cap. There is no overall login
deadline in the action. GitHub Actions job and step timeouts still apply.
Each fresh OIDC acquisition uses a fixed 15-second timeout and at most two
retries (or fewer when max-retries is lower). This setting does not change the issued key's lifetime.

Output: `NUGET_API_KEY`, compatible with workflows using `NuGet/login`.
Network failures and HTTP 408, 429, 500, 502, 503, and 504 are retried with
exponential backoff: 10, 30, 90, then 120 seconds, plus up to 50% jitter
(default waits are 10–15 and 30–45 seconds). Valid Retry-After values are honored up to five minutes;
longer requested delays stop the action so it never retries earlier than the
server permits. Logs show each attempt's timeout and elapsed time, and
`waiting Xms...` before each retry. Other failures stop immediately.
Credentials and successful response bodies are never logged. Error response
diagnostics are sanitized and can be disabled with `log-responses: 'false'`.
Each token-exchange retry requests a fresh OIDC token because NuGet.org tokens
are single-use. Set a custom endpoint only for a token service you trust: it
receives the OIDC credential.
Requests use native Node HTTPS with a ten-second connection timeout and no
implicit header/body timeout; the attempt timeout covers the full response.
Redirects are refused. Known certificate and request-configuration failures stop
immediately. Logs include allowlisted transport error codes and whether response
headers arrived, without raw exception messages. Diagnostic response reads are
limited to two seconds. Custom CA settings use Node's certificate configuration;
this transport does not automatically configure proxies from environment variables.

With `log-responses` enabled, every HTTP failure emits a diagnostic summary with
`httpStatus` and `bodyStatus`, even when no diagnostic headers or message exist.
JSON error messages (including problem-detail fields) and plain-text errors are
sanitized and limited to 512 characters after reading at most 8192 bytes. Empty,
unsupported (including HTML), oversized, malformed JSON, unreadable, and timed-out
bodies are identified explicitly. Successful response bodies are never logged.
