# DeployBay builds this file (it only looks for ./Dockerfile). Its in-cluster
# Kaniko build can't handle the full Next.js build, so the real image is built
# by GitHub Actions from Dockerfile.build and pushed to GHCR; this just pulls
# the latest one. Every DeployBay Redeploy re-pulls it, picking up new code.
FROM ghcr.io/doorloop/dl-bonustrackingdb:latest
EXPOSE 3000
