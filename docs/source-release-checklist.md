# Making the corresponding source public (AGPL-3.0-or-later)

BlueprintIQ is released under the GNU Affero General Public License v3 or later, and PyMuPDF/MuPDF, which it uses, is AGPL-3.0 too. Anyone who uses a deployed copy over a network is entitled to the source of **the version running there** (section 13). A private repository does not satisfy this. **This checklist has not been carried out: the repository is private, no source archive has been uploaded, and nothing has been published.** Each step below needs the owner's decision.

This is a practical checklist, not legal advice.

## 1. Decide how the source will be offered

* [ ] Public repository (simplest: the footer links the repository), **or** a public source archive of the exact commit, linked from the footer. Either must be readable without signing in.
* [ ] Decide whether the public repository keeps the full history or starts fresh from the release commit. A fresh start avoids the history items below but means the published source is a snapshot; the licence only requires the source of what runs.

## 2. Before anything becomes public

* [ ] **Personal data in history.** One commit author address is a personal email. Decide: rewrite history, start a fresh repository from the release commit, or accept it. Check `git log --format='%an <%ae> %cn <%ce>' | sort -u` and any file that names a person.
* [ ] **Secrets.** History holds no env files; confirm again with a scan of the full history (`git log -p` searches for keys, tokens, passwords, private keys) and a secret scanner of your choice. None should be found; if one is, rotate it and clean the history.
* [ ] **Proprietary material.** The proprietary SolidWorks drawing was never copied into the repository. Confirm with `git log --all --diff-filter=A --name-only | grep -i '\.pdf$'`: only the synthetic fixtures (`backend/tests/fixtures/drawings`, `frontend/tests/fixtures`) and the two samples in `frontend/public/samples` should appear. Check no screenshot, doc or test name quotes its title block or wording.
* [ ] **Licence files.** `LICENSE` (AGPL-3.0 text), `NOTICE.md` (third-party notices), `package.json` and the README licence section are present and unchanged. The licence stays `AGPL-3.0-or-later`.
* [ ] **Docs reviewed for private details:** local paths, usernames and anything that should not be public (the `docs/` folder and README were written to avoid these; re-read them).
* [ ] Branch protection and the default branch set as wanted; CI green on the release commit.

## 3. The exact corresponding source

* [ ] Tag the release commit (for example `v0.1.0`) and note its SHA.
* [ ] Build the image **from that tag**, and give the build the source address of that tag: `--build-arg SOURCE_URL=https://<host>/<owner>/<repo>/tree/<tag>` (or the archive address). The footer then links the exact version, and the "third-party notices" link is derived from it.
* [ ] If you change the code after the tag, tag again and rebuild: the source link must always match what runs. A modified deployment must publish its modified source.

## 4. Verify before launch

* [ ] `node deploy/verify-source-url.mjs <that address> --online` passes (https, no credentials, reachable anonymously; a private repository fails it).
* [ ] Open the address in a private browser window with no sign-in and confirm the source and `LICENSE` and `NOTICE.md` are visible.
* [ ] After deployment, open the site, follow the footer "Source code" link and confirm it is the same tag.

## 5. Do not

Do not change the repository visibility, push to a public remote or upload an archive until the owner decides and the items above are done.
