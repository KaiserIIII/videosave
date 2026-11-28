# VideoSave MCP bundle

VideoSave runs locally over stdio and requires Node.js 24 or newer. The MCP bundle includes the official v1.3.2 desktop release and its MIT license. Node.js is installed separately. FFmpeg and FFprobe support remuxing and verification. See the [MCP guide](../../docs/mcp.md) for optional platform download tools and browser integration.

## Build and verify

Download `VideoSave-1.3.2.zip` from the official [v1.3.2 release](https://github.com/KaiserIIII/videosave/releases/tag/v1.3.2). From the repository root, run the following command with CPython 3.9 or newer.

```sh
python packaging/mcp-registry/build_bundle.py VideoSave-1.3.2.zip dist/VideoSave-1.3.2-mcp.mcpb
```

The builder checks the hash of the source ZIP. Match its output hash to `packages[0].fileSha256` in `server.json`. A client supporting MCPB can install the bundle locally. For other clients, extract the bundle and use `node` with the absolute path to the extracted `tools/mcp-server.mjs` as its argument. Invoke `get_version` to verify that the server reports `1.3.2`.

## Registry publication

Add the MCPB file as a distinct asset on the corresponding GitHub release. Check that the URL in `server.json` is public and its SHA-256 matches. For this repository, run the manual [Publish MCP Registry workflow](https://github.com/KaiserIIII/videosave/actions/workflows/publish-mcp.yml) on `main`. It verifies the asset and authenticates with GitHub OIDC. The workflow uses the official Registry publisher v1.8.21 from commit `7e39f2d4fc2c67cf5295fe3ae04fe23d52e85c99`, pinned and reviewed on 2026-11-28. The publisher repository is [transitioning from MIT to Apache-2.0](https://github.com/modelcontextprotocol/registry/blob/7e39f2d4fc2c67cf5295fe3ae04fe23d52e85c99/LICENSE). It is downloaded for the job only.

To publish locally, authenticate as the GitHub account that controls `io.github.kaiseriiii/*` and use the [official publisher](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/quickstart.mdx).

```sh
mcp-publisher validate packaging/mcp-registry/server.json
mcp-publisher login github
mcp-publisher publish packaging/mcp-registry/server.json
```

Confirm that the [Registry API](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.kaiseriiii%2Fvideosave) returns the `io.github.kaiseriiii/videosave` entry with version `1.3.2` and the expected asset URL.
