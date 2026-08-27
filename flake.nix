{
  description = "Quasar monorepo: React/Vite UI + Common Lisp control plane + CLOG host";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" ];
      forAllSystems = fn: builtins.listToAttrs (map (s: { name = s; value = fn s; }) systems);
    in
    {
      devShells = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
          runtimeLibs = with pkgs; [
            openssl
            rabbitmq-c
            libffi
            sqlite
            lmdb
          ];
        in
        {
          default = pkgs.mkShell {
            buildInputs = with pkgs; [
              sbcl
              nodejs_22
              pkg-config
              chromium
              gcc
              gnumake
              curl
              git
            ] ++ runtimeLibs;

            shellHook = ''
              export LD_LIBRARY_PATH="${pkgs.lib.makeLibraryPath runtimeLibs}''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
              export TMPDIR="/tmp"
              export TMP="/tmp"
              export TEMP="/tmp"
              export XDG_CONFIG_HOME="''${XDG_CONFIG_HOME:-$HOME/.config}"
              export XDG_CACHE_HOME="''${XDG_CACHE_HOME:-$HOME/.cache}"
              export CL_SOURCE_REGISTRY="(:source-registry (:tree \"$HOME/quicklisp/local-projects/\") (:tree \"$HOME/quicklisp/dists/quicklisp/software/\") (:tree \"$PWD/systems/\") :ignore-inherited-configuration)"
              mkdir -p "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME"
              echo "Quasar monorepo dev environment ready"
              echo "  nix develop && npm ci && npm run dev"
            '';
          };
        });
    };
}
