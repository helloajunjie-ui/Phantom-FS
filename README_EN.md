# 👻 Phantom-FS
**The Ultimate Zero-Trust Cypher-Vault.**

> *"Your data is everywhere, yet nowhere to be found. Not even God can piece it together without you."*

[![License: MIT](https://img.shields.io/badge/License-MIT-cyan.svg)](#) [![Security: Military Grade](https://img.shields.io/badge/Security-Military%20Grade-red.svg)](#)

---

## 👁️ Privacy, Redefined

Entrusting your darkest secrets to iCloud, Google Drive, or any enterprise cloud is like handing over the knife by the blade. **We trust no cloud. We trust only math.**

Phantom-FS is not a cloud drive. It is a **cypher-shredding and reassembly engine** that lives in device memory.

It slices your confidential files — financial statements, classified videos, private key ledgers — into high-entropy encrypted dust scattered across the network. Without your consent, this data is nothing but electronic white noise to anyone who touches it.

---

## ⚔️ Core Capabilities

### 1. Cloud Degradation: Every Cloud Drive Becomes a "Dumb Disk"
Whether you store encrypted chunks on local disk, private cloud, or public S3, the server has zero knowledge of what you stored or what the file is named. Even if the cloud provider suffers a total breach, all the attacker gets is indecipherable garbage.

### 2. Physical Cold Wallet: QR Code Treasure Map
The highest level of secrets should never live on a USB drive. After encryption, Phantom-FS generates a tiny **high-density QR code (Manifest)** — a few KB at most.
Print it on paper. Lock it in a bank vault. To decrypt, scan it with any browser. True physical isolation for digital assets. Immune to power loss, hackers, and hardware decay.

### 3. O(1) Streaming: Millisecond Seeking Through Gigabytes
Thanks to the revolutionary **Deterministic IV Derivation**, when you decrypt a 50GB classified video, there is no need to wait for a full download. Drag the seek bar to any position — the engine derives the local cipher and decrypts it in milliseconds. **Silky smooth. Zero memory leak.**

### 4. Burn After Reading: A Ghost in Memory
The moment you close the browser, the system issues a hardware-level instruction (`secureZero`) to overwrite every byte of decrypted content in memory. Pull the plug and it's gone. No residue. No trace.

---

## 🏛️ Dual-End Matrix: Every Scenario Covered

*   🛡️ **Phantom-CLI (Heavy Infantry)**
    *   **For**: Your private NAS, Mac, or Linux server.
    *   **Power**: Go language, maxing out CPU hardware acceleration. Silently encrypts hundreds of gigabytes and pushes them to the cloud on a cron schedule.
*   🔑 **Phantom-Web (Ghost Keyhole)**
    *   **For**: Any device with a browser — including a borrowed computer.
    *   **Power**: **Zero install.** Open a static HTML page, drop in the Manifest (or scan the QR code), type the password from your brain, and the secret is reassembled in memory. Walk away clean.

---

## 🔐 Triple Physical Boundaries

To recover data, all three physically separated elements must be reunited:

1.  **The Boxes (Chunks)**: Binary encrypted fragments scattered across cloud or disk.
2.  **The Treasure Map (.ptm / QR Code)**: Records the order, salt, and IV — useless without the key.
3.  **The Only Key (Your Password)**: Never touches the network. Derived into a 256-bit master key in local memory only at the moment of use, then zeroed.

> *"Even if someone puts a gun to your head and demands your server, all you can hand over is a pile of sand. The key was never on the server. It was always in your mind."*

---

## 🚀 Start Your Ghost Journey

👉 **[Download Phantom-CLI (Windows / Mac / Linux)](phantom-core-go/)**
👉 **[Try Phantom-Web Online (Zero Install, Fully Local)](phantom-web/)**

---

> Security model: [`SECURITY.md`](SECURITY.md) | Technical architecture: [`ARCHITECTURE.md`](ARCHITECTURE.md)
