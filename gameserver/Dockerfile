# MicroVM image for the Asteroids game server. Lives at the game-server package
# root so the build artifact zip has a Dockerfile at its root, as CreateMicroVmImage
# requires. The build pipeline (cli buildImage) bundles the server to dist/bundle.mjs
# with esbuild, so this image just needs Node + the single bundled file.
FROM public.ecr.aws/docker/library/node:20-bookworm-slim

WORKDIR /app

# The esbuild bundle is self-contained (ws + @game/shared inlined).
COPY dist/bundle.mjs ./bundle.mjs

ENV NODE_ENV=production \
    GAME_PORT=8080 \
    HOOK_PORT=9000 \
    HOOKS_ENABLED=true

# 8080 = gameplay WS, 9000 = lifecycle hooks. Both must be exposed.
EXPOSE 8080 9000

CMD ["node", "bundle.mjs"]
