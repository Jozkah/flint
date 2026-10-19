class Flint < Formula
  desc "Local-first agent harness: terminal agent console and headless runtime"
  homepage "https://github.com/Jozkah/flint"
  version "1.0.1"
  license "Apache-2.0"

  on_macos do
    on_arm do
      url "https://github.com/Jozkah/flint/releases/download/v1.0.1/flint-1.0.1-aarch64-apple-darwin.tar.gz"
      sha256 "8ea1189c5f3fe5c43c7e1f837f467289f67847226bd09a33f333dd9e09d2c359"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/Jozkah/flint/releases/download/v1.0.1/flint-1.0.1-aarch64-unknown-linux-gnu.tar.gz"
      sha256 "04b1b1e877609f852691bd3ee70772ea97c3b655fcbddfe13b8b6fb33c549500"
    end
    on_intel do
      url "https://github.com/Jozkah/flint/releases/download/v1.0.1/flint-1.0.1-x86_64-unknown-linux-gnu.tar.gz"
      sha256 "83202d02b06cf6ea25dc059e1adccad32cadb53a24d7b4ab23b3dfbec28a9d90"
    end
  end

  def install
    bin.install "flint"
  end

  test do
    assert_match "flint", shell_output("#{bin}/flint --help")
  end
end
