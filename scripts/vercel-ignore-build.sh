#!/usr/bin/env bash
# Vercel's Ignored Build Step (vercel.json `ignoreCommand`). Exit 0 skips the
# build, exit 1 builds.
#
# Skips a deployment whose commits touch nothing the web app is built from:
# the iPhone app, the desktop shell, tests, CI config, migrations, plans and
# docs. Every deployment Vercel keeps counts against the team's 10 GB
# Deployment Storage, and a PR that only changes ios/ used to build a fresh
# copy of the whole site on every push.
#
# The diff runs from the last deployment on this branch
# (VERCEL_GIT_PREVIOUS_SHA) when the clone has it, otherwise from HEAD^. When
# neither can be read, it builds: a wasted build is cheaper than a missed one.

set -u

base="${VERCEL_GIT_PREVIOUS_SHA:-}"
if [ -z "$base" ] || ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
  base="HEAD^"
  if ! git rev-parse --verify -q "HEAD^" >/dev/null; then
    echo "ignore-build: no base commit to compare against; building."
    exit 1
  fi
fi

# Paths the Next.js build never reads. Anything not listed here builds.
if git diff --quiet "$base" HEAD -- . \
  ':(exclude)ios/' \
  ':(exclude)electron/' \
  ':(exclude)tests/' \
  ':(exclude).github/' \
  ':(exclude)supabase/' \
  ':(exclude)memory/' \
  ':(exclude)design/' \
  ':(exclude,glob)*.md' \
  ':(exclude)scripts/README.md' \
  ':(exclude)playwright.config.ts' \
  ':(exclude)playwright.demo.config.ts' \
  ':(exclude)vitest.config.ts' \
  ':(exclude)vitest.eval.config.ts'; then
  echo "ignore-build: only non-web paths changed since ${base}; skipping."
  exit 0
fi

echo "ignore-build: web app changed since ${base}; building."
exit 1
