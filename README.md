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
| `max-retries` | `3` | Retries per request, from 0 through 5 |
| `timeout-seconds` | `240` | Per-attempt timeout, from 1 through 600 seconds |

The default timeout is 240 seconds (four minutes) for the whole HTTP attempt,
including reading the body. `NuGet/login` uses a 180-second socket inactivity
timeout. Set `timeout-seconds: '300'`
if you want five minutes per attempt. Retries are additional attempts, not part
of a single overall deadline. This setting does not change the issued key's
lifetime: NuGet.org currently issues keys valid for one hour.

Output: `NUGET_API_KEY`, compatible with workflows using `NuGet/login`.
Network failures and HTTP 408, 429, 500, 502, 503, and 504 are retried with
exponential backoff with jitter, capped at 30 seconds per delay. HTTP 500 uses
longer backoff: 30, 60, then 120 seconds (plus jitter, capped at 120 seconds),
giving the default three retries about three and a half minutes to recover. Valid Retry-After
values are honored up to five minutes; longer requested delays stop the action
so it never retries earlier than the server permits. Retry counts and delays
are logged without credentials or response bodies. Other failures
stop immediately. Response bodies and credentials are never included in errors.
Each token-exchange retry requests a fresh OIDC token because NuGet.org tokens
are single-use. Set a custom endpoint only for a token service you trust: it
receives the OIDC credential.
Requests refuse redirects. Proxies and custom CA settings must be configured for
Node's native fetch on self-hosted runners.
