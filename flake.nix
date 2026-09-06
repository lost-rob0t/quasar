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
      packages = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          # The standalone web edition bundle: the Vite production build of
          # frontend/ served as a root-hosted static SPA. This is the same
          # artifact CLOG serves locally (frontend/dist); the hosted edition
          # omits the Common Lisp control plane, per the capability boundary.
          web-dist = pkgs.buildNpmPackage {
            pname = "quasar-web-dist";
            version = "0.2.0";
            src = self;

            npmDepsHash = "sha256-wx77iw2aDWs2m/F6h4K9HQkI5E1l8wo1ULf2u7Dy6NM=";
            makeCacheWritable = true;
            forceGitDeps = true;
            nativeBuildInputs = [ pkgs.git ];

            npmBuild = "npm --prefix frontend run build";

            installPhase = ''
              runHook preInstall
              test -f frontend/dist/index.html
              test -f frontend/dist/404.html
              mkdir -p "$out/share/quasar-web"
              cp -r frontend/dist "$out/share/quasar-web/dist"
              runHook postInstall
            '';

            passthru.distRoot = "share/quasar-web/dist";

            meta = with pkgs.lib; {
              description = "Quasar standalone web edition (Vite production bundle)";
              license = licenses.agpl3Only;
              platforms = platforms.linux;
            };
          };

          default = self.packages.${system}.web-dist;
        });
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
              export QUASAR_DEV_NIX_READY=1
              export QUASAR_PRODUCTION_NIX_READY=1
              export QUASAR_PRODUCTION_SMOKE_NIX_READY=1
              export QUASAR_TEK9_PATH="''${QUASAR_TEK9_PATH:-$HOME/starintel/tek9}"
              export LD_LIBRARY_PATH="${pkgs.lib.makeLibraryPath runtimeLibs}''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
              export TMPDIR="/tmp"
              export TMP="/tmp"
              export TEMP="/tmp"
              export XDG_CONFIG_HOME="''${XDG_CONFIG_HOME:-$HOME/.config}"
              export XDG_CACHE_HOME="''${XDG_CACHE_HOME:-$HOME/.cache}"
              export CL_SOURCE_REGISTRY="(:source-registry (:tree \"$QUASAR_TEK9_PATH/\") (:tree \"$HOME/quicklisp/local-projects/\") (:tree \"$HOME/quicklisp/dists/quicklisp/software/\") (:tree \"$PWD/systems/\") :ignore-inherited-configuration)"
              mkdir -p "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME"
              echo "Quasar monorepo dev environment ready"
              echo "  nix develop && npm ci && npm run dev"
            '';
          };
        });
    };
}
