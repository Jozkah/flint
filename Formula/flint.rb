class Flint < Formula
  desc "Local-first agent harness: terminal agent console and headless runtime"
  homepage "https://github.com/Jozkah/flint"
  version "1.0.0"
  license "Apache-2.0"

  on_macos do
    on_arm do
      url "https://github.com/Jozkah/flint/releases/download/v1.0.0/flint-1.0.0-aarch64-apple-darwin.tar.gz"
      sha256 "bf558068da6be28866e674b517ab127d19a6f542ab1f6b0649a53cb1af46a6b3"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/Jozkah/flint/releases/download/v1.0.0/flint-1.0.0-aarch64-unknown-linux-gnu.tar.gz"
      sha256 "281b72caa3a35a4a31be12929a3c6eab43a41b2b727bc3fad5dec9f990bdaef9"
    end
    on_intel do
      url "https://github.com/Jozkah/flint/releases/download/v1.0.0/flint-1.0.0-x86_64-unknown-linux-gnu.tar.gz"
      sha256 "08e665b15dc4f1397294f967c0f4069242fcdb7be987a186b5031c24f1b066cf"
    end
  end

  def install
    bin.install "flint"
  end

  test do
    assert_match "flint", shell_output("#{bin}/flint --help")
  end
end
