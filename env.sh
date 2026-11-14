# À sourcer pour utiliser les outils installés localement dans .toolchain :
#   source env.sh
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
export RUSTUP_HOME="$ROOT/.toolchain/rustup"
export CARGO_HOME="$ROOT/.toolchain/cargo"
export PATH="$ROOT/.toolchain/cargo/bin:$ROOT/.toolchain/node/bin:$ROOT/.toolchain/gh/bin:$PATH"
