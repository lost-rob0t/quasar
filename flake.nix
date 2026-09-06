{
  description = "Quasar monorepo: React/Vite UI + Common Lisp control plane + CLOG host";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    tek9 = {
      url = "git+https://git.starintel.actor/starintel-labs/tek9?rev=ca24ef35ea6877420cbca057dd7fb702fe29a740";
      flake = false;
    };
    starintel-biz = {
      url = "git+https://git.starintel.actor/starintel-labs/starintel-biz?rev=c25f9e8972c2392c9c43f30c2254654012d26d38";
      flake = false;
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      tek9,
      starintel-biz,
    }:
    let
      systems = [ "x86_64-linux" ];
      forAllSystems =
        fn:
        builtins.listToAttrs (
          map (s: {
            name = s;
            value = fn s;
          }) systems
        );
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          runtimeLibs = with pkgs; [
            openssl
            rabbitmq-c
            libffi
            sqlite
            lmdb
          ];

          webDist = pkgs.buildNpmPackage {
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

          lmdbLib = pkgs.sbcl.buildASDFSystem {
            pname = "lmdb";
            version = "20250622-git";
            src = pkgs.sbclPackages.lmdb.src;
            lispLibs = with pkgs.sbcl.pkgs; [
              alexandria
              bordeaux-threads
              cl-reexport
              mgl-pax
              osicat
              trivial-features
              trivial-garbage
              trivial-utf-8
            ];
            nativeLibs = [ pkgs.lmdb ];
            systems = [ "lmdb" ];
            asdFilesToKeep = [ "lmdb.asd" ];
            dontStrip = true;
          };

          tek9Lib = pkgs.sbcl.buildASDFSystem {
            pname = "tek9";
            version = "0.2.0";
            src = "${tek9}/src";
            lispLibs = with pkgs.sbcl.pkgs; [
              alexandria
              bordeaux-threads
              serapeum
              jsown
              lmdbLib
              cl-conspack
            ];
            nativeLibs = [ pkgs.lmdb ];
            systems = [ "tek9" ];
            asdFilesToKeep = [ "tek9.asd" ];
            dontStrip = true;
          };

          quasarLib = pkgs.sbcl.buildASDFSystem {
            pname = "quasar";
            version = "0.2.0";
            src = self;
            lispLibs = with pkgs.sbcl.pkgs; [
              babel
              bordeaux-threads
              clack
              clog
              dexador
              jsown
              quri
              sento
              websocket-driver
              tek9Lib
            ];
            nativeLibs = runtimeLibs;
            systems = [
              "quasar-control"
              "quasar-starlang"
              "quasar-web"
            ];
            asdFilesToKeep = [
              "quasar-control.asd"
              "quasar-starlang.asd"
              "quasar-web.asd"
            ];
            dontStrip = true;
            postInstall = ''
              mkdir -p "$out/frontend"
              cp -r ${webDist}/share/quasar-web/dist "$out/frontend/dist"
            '';
          };

          quasarAuthLib = pkgs.sbcl.buildASDFSystem {
            pname = "quasar-auth-host";
            version = "0.1.0";
            src = starintel-biz;
            lispLibs = with pkgs.sbcl.pkgs; [
              babel
              clack
              dexador
              ironclad
              jsown
              quri
              quasarLib
            ];
            nativeLibs = [ pkgs.openssl ];
            systems = [
              "quasar-auth"
              "quasar-auth-host"
            ];
            asdFilesToKeep = [
              "quasar-auth.asd"
              "quasar-auth-host.asd"
            ];
            dontStrip = true;
          };

          sbclRuntime = pkgs.sbcl.withPackages (_: [
            quasarLib
            quasarAuthLib
          ]);

          quasarServer = pkgs.stdenv.mkDerivation {
            pname = "quasar-server";
            version = "0.2.0";
            dontUnpack = true;
            dontStrip = true;
            nativeBuildInputs = [ pkgs.makeWrapper ];

            buildPhase = ''
              ${sbclRuntime}/bin/sbcl --non-interactive --no-userinit --no-sysinit \
                --eval "(require :asdf)" \
                --eval "(asdf:load-system :quasar-web)" \
                --eval "(asdf:load-system :quasar-auth-host)" \
                --eval "(sb-ext:save-lisp-and-die \"quasar-server\" :toplevel 'quasar.app:main :executable t :compression t)"
            '';

            installPhase = ''
              mkdir -p "$out/bin"
              cp quasar-server "$out/bin/"
              wrapProgram "$out/bin/quasar-server" \
                --set TMPDIR /tmp \
                --set TMP /tmp \
                --set TEMP /tmp \
                --prefix LD_LIBRARY_PATH : "${pkgs.sbclPackages.osicat}/posix" \
                --prefix LD_LIBRARY_PATH : "${pkgs.lib.makeLibraryPath runtimeLibs}"
            '';

            meta = with pkgs.lib; {
              description = "Quasar Common Lisp control-plane and CLOG runtime";
              license = licenses.agpl3Only;
              mainProgram = "quasar-server";
              platforms = platforms.linux;
            };
          };
        in
        {
          # The standalone web edition bundle: the Vite production build of
          # frontend/ served as a root-hosted static SPA. This is the same
          # artifact CLOG serves locally (frontend/dist); the hosted edition
          # omits the Common Lisp control plane, per the capability boundary.
          web-dist = webDist;
          quasar-server = quasarServer;
          quasar = quasarLib;
          quasar-auth-host = quasarAuthLib;

          default = webDist;
        }
      );
      devShells = forAllSystems (
        system:
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
            buildInputs =
              with pkgs;
              [
                sbcl
                nodejs_22
                pkg-config
                chromium
                gcc
                gnumake
                curl
                git
              ]
              ++ runtimeLibs;

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
        }
      );
    };
}
