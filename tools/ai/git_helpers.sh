#!/usr/bin/env bash

set -euo pipefail

########################################
# Logging
########################################

log() {
  echo "[git-helper] $1"
}

fail() {
  echo "[git-helper][ERROR] $1" >&2
  exit 1
}

########################################
# Repo checks
########################################

ensure_git_repo() {
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "Not a git repository"
}

ensure_clean_index() {
  if ! git diff --cached --quiet; then
    fail "Index is not clean (staged changes already present)"
  fi
}

########################################
# Status / diff helpers
########################################

git_status_short() {
  git status --short
}

git_diff_full() {
  git diff --no-color
}

git_diff_cached() {
  git diff --cached --no-color
}

git_changed_files() {
  git diff --name-only
}

########################################
# File filtering
########################################

filter_files() {
  local include_pattern="$1"
  local exclude_pattern="$2"

  git_changed_files | grep -E "$include_pattern" | grep -Ev "$exclude_pattern" || true
}

########################################
# Staging
########################################

stage_files() {
  for f in "$@"; do
    log "Staging file: $f"
    git add "$f"
  done
}

# Partial staging via patch (non-interactive best effort)
stage_by_pattern() {
  local pattern="$1"

  git diff | awk "
    BEGIN { keep=0 }
    /^diff --git/ { keep=0 }
    $0 ~ /$pattern/ { keep=1 }
    { if (keep) print }
  " | git apply --cached --unidiff-zero || true
}

########################################
# Safety checks
########################################

detect_secrets() {
  git diff | grep -E "(API_KEY|SECRET|TOKEN|password)" && return 0 || return 1
}

detect_debug_code() {
  git diff | grep -E "(console\.log|print\(|debugger)" && return 0 || return 1
}

########################################
# Checks (lint/test)
########################################

run_checks() {
  for cmd in "$@"; do
    log "Running check: $cmd"
    if ! eval "$cmd"; then
      fail "Check failed: $cmd"
    fi
  done
}

########################################
# Commit
########################################

build_commit_message() {
  local type="$1"
  local scope="$2"
  local summary="$3"

  echo "${type}(${scope}): ${summary}"
}

commit() {
  local message="$1"

  git diff --cached --quiet && fail "Nothing staged to commit"

  log "Committing: $message"
  git commit -m "$message"
}

########################################
# Post-commit info
########################################

last_commit_sha() {
  git rev-parse --short HEAD
}

list_staged_files() {
  git diff --cached --name-only
}
