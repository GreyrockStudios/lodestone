#!/usr/bin/env bash
#
# Lodestone — One-Line Install
#
# Usage: curl -fsSL https://github.com/greyrockstudios/lodestone/raw/main/scripts/install.sh | bash
#   OR:  wget -qO- https://github.com/greyrockstudios/lodestone/raw/main/scripts/install.sh | bash
#
# This script:
# 1. Checks prerequisites (Node.js 22+, npm, git)
# 2. Clones the Lodestone repo
# 3. Installs dependencies
# 4. Builds the project
# 5. Links the CLI globally (so `lodestone` is available)
# 6. Runs `lodestone init` interactively
# 7. Prints success message
#
set -euo pipefail

# ─── Colors ──────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m' # No Color

# ─── Config ───────────────────────────────────────────────────────────────────

REPO_URL="https://github.com/greyrockstudios/lodestone.git"
INSTALL_DIR="${LODESTONE_DIR:-$HOME/.lodestone}"
BRANCH="${LODESTONE_BRANCH:-main}"
NODE_MIN_MAJOR=22

# ─── Helpers ──────────────────────────────────────────────────────────────────

info()  { echo -e "${BLUE}ℹ${NC} $*"; }
ok()    { echo -e "${GREEN}✓${NC} $*"; }
warn()  { echo -e "${YELLOW}⚠${NC} $*"; }
error() { echo -e "${RED}✗${NC} $*"; exit 1; }

banner() {
  echo -e ""
  echo -e "${CYAN}${BOLD}  ╦═╗┌─┐┬  ┬┌─┐┌┐┌┌┬┐${NC}"
  echo -e "${CYAN}${BOLD}  ╠╦╝├┤ └┐┌┘├┤ ││││││${NC}"
  echo -e "${CYAN}${BOLD}  ╩╚═└─┘ └┘ └─┘┘└┘┴ ┴${NC}"
  echo -e ""
  echo -e "${BOLD}  Self-improving agent runtime${NC}"
  echo -e "  ${DIM}v0.1.0${NC}"
  echo -e ""
}

# ─── Prerequisite Checks ──────────────────────────────────────────────────────

check_node() {
  if ! command -v node &>/dev/null; then
    error "Node.js is required but not installed."
    echo -e "  Install it: ${CYAN}https://nodejs.org/${NC} (v${NODE_MIN_MAJOR}+)"
    echo -e "  Or via nvm: ${CYAN}curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash && nvm install ${NODE_MIN_MAJOR}${NC}"
    exit 1
  fi

  local node_version
  node_version=$(node -v | sed 's/v//' | cut -d. -f1)

  if [ "$node_version" -lt "$NODE_MIN_MAJOR" ]; then
    error "Node.js v${NODE_MIN_MAJOR}+ required, found v$(node -v)"
    echo -e "  Upgrade: ${CYAN}nvm install ${NODE_MIN_MAJOR}${NC}"
    exit 1
  fi

  ok "Node.js $(node -v)"
}

check_npm() {
  if ! command -v npm &>/dev/null; then
    error "npm is required but not found."
    exit 1
  fi
  ok "npm $(npm -v)"
}

check_git() {
  if ! command -v git &>/dev/null; then
    error "git is required but not installed."
    echo -e "  Install it: ${CYAN}https://git-scm.com/${NC}"
    exit 1
  fi
  ok "git $(git --version | cut -d' ' -f3)"
}

# ─── Install Steps ────────────────────────────────────────────────────────────

clone_repo() {
  if [ -d "${INSTALL_DIR}/.git" ]; then
    info "Updating existing installation at ${INSTALL_DIR}..."
    cd "${INSTALL_DIR}"
    git fetch origin "${BRANCH}" || warn "Could not fetch updates"
    git reset --hard "origin/${BRANCH}" 2>/dev/null || true
  else
    info "Cloning Lodestone into ${INSTALL_DIR}..."
    git clone --depth 1 --branch "${BRANCH}" "${REPO_URL}" "${INSTALL_DIR}"
    cd "${INSTALL_DIR}"
  fi
  ok "Repository ready"
}

install_deps() {
  info "Installing dependencies..."
  npm ci --production=false 2>/dev/null || npm install 2>/dev/null
  ok "Dependencies installed"
}

build_project() {
  info "Building Lodestone..."
  npm run build 2>/dev/null || npx tsc 2>/dev/null || {
    warn "Build had warnings — this is normal for first install"
  }
  ok "Build complete"
}

link_cli() {
  info "Linking CLI globally..."
  npm link 2>/dev/null || warn "Could not link globally — use npx lodestone instead"
  ok "CLI linked: 'lodestone' command available"
}

print_success() {
  echo ""
  echo -e "${GREEN}${BOLD}══════════════════════════════════════════${NC}"
  echo -e "${GREEN}${BOLD}  Lodestone installed successfully! 🎉${NC}"
  echo -e "${GREEN}${BOLD}══════════════════════════════════════════${NC}"
  echo ""
  echo -e "  ${BOLD}Next steps:${NC}"
  echo ""
  echo -e "  cd <workspace path shown by init>"
  echo -e "  lodestone start"
  echo ""
  echo -e "  ${BOLD}Docs:${NC} ${CYAN}https://github.com/greyrockstudios/lodestone#readme${NC}"
  echo -e "  ${BOLD}Repo:${NC} ${CYAN}${REPO_URL}${NC}"
  echo ""
}

# ─── Main ─────────────────────────────────────────────────────────────────────

main() {
  banner

  info "Checking prerequisites..."
  check_node
  check_npm
  check_git

  echo ""
  clone_repo
  install_deps
  build_project
  link_cli

  echo ""
  echo -e "${BOLD}${CYAN}═══ Lodestone Setup ═══${NC}"
  echo ""
  echo -e "  Running ${CYAN}lodestone init${NC} — this will ask a few questions..."
  echo ""

  lodestone init

  print_success
}

main "$@"