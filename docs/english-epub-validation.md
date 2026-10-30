# English EPUB typography: first validation matrix

2026-10-30. Implements the initial OS-02/OS-03 support slice for personal English EPUB libraries. Kindle is the user's preferred acceptance target; **no actual Kindle, Send to Kindle, USB, Apple Books or Kobo display has been accepted in this change**. Engine success, format validation and device appearance are separate results.

## Supported change

The opt-in `reader-editorial` flow still uses deterministic `editorial-1` CSS, with no model calls. It now admits a single `div.chapter` wrapper containing otherwise supported ordinary prose. Source tags, text, paragraph order, links and images remain unchanged. The first heading inside that explicit chapter container receives chapter-opening styling even when its source tag is `h2`.

The additional audited markers are Gutenberg's `x-ebookmaker`, `x-ebookmaker-2` and `x-ebookmaker-3` on `body`, `chapter` on the one chapter wrapper, and `noindent`, `center` and a verified `asterism` on paragraphs. Asterisms must contain actual separator characters, direct text and optional `br` only; nested prose, images and whitespace-only markers stay protected. These markers do not identify the book's language.

CSS admission additionally understands `a[href]` existence matching. It can replace a `@media screen` block only when its rules target `body`/`html` and contain only literal left/right margins. Conditional emphasis, other media queries, layout, arbitrary attribute selectors, unknown classes, `pre`, tables, unsupported containers and complexity limits remain protected. This is not general Gutenberg, Calibre or Standard Ebooks template support.

## Paragraph language policy

Language comes from direct OPF metadata `dc:language` elements and the XHTML root and block-scope `lang`/`xml:lang` declarations (including chapter wrappers, headings, paragraphs and blockquotes). Values are normalized for comparison; source metadata is not rewritten. Conflicting primary languages, invalid declarations or conflicting multiple metadata languages preserve the document with `EDITORIAL_LANGUAGE_CONFLICT`. Regional English tags may differ because this policy does not make regional typography decisions. A foreign inline phrase alone does not redefine the paragraph or book language.

- Explicit English: normal paragraphs use `1.2em` indentation, and chapter/scene openings and explicitly unindented paragraphs use zero indentation.
- Explicit Chinese: the prior `2em` paragraph policy remains.
- Missing or other languages: conservative neutral paragraph spacing with no automatic paragraph indentation. This does not assert language-specific design support.

Ordinary prose still does not force font family, size, line height, text/background color or nonzero horizontal body margins. Relative headings, quotes and source-marked special paragraphs remain distinct. New reports add `documents[].editorial.language` evidence (`policy`, normalized `package` and `document` declarations); older reports may lack the field. New human-readable warning messages are English; existing warning codes and book titles are unchanged. Legacy non-editorial typography and stage order are unchanged; the new warning wording is shared by new exports.

## Real input matrix

Four distinct books were downloaded from their official publishers, with one additional Alice format variant. These are real books, not the original synthetic fixtures. SHA256 identifies the exact bytes checked; official downloads may change later. Full archives, source text, engine reports and generated books stay outside this repository.

| Exact source                                                                                                                                         | EPUB | Source SHA256                                                      | Source bytes |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------ | -----------: |
| [Alice's Adventures in Wonderland, Gutenberg](https://www.gutenberg.org/ebooks/11), EPUB 3 images                                                    | 3.0  | `4f81245d31380ac1d6eafb9a321e3691369bc70985736ae4bccf849a4f784036` |       189249 |
| Same book, official EPUB 2 noimages                                                                                                                  | 2.0  | `08a2de3a58226311915bd87056e59ed4ee49a284dcb5e722fef415bca4032a4b` |       136756 |
| [Walden, and On The Duty Of Civil Disobedience, Gutenberg](https://www.gutenberg.org/ebooks/205), EPUB 2 images                                      | 2.0  | `f2520d06c933d53240fecd39cfa82e2ec8591bfcc5365cb689a3091db35c133c` |       688331 |
| [Songs of Innocence and of Experience, Gutenberg](https://www.gutenberg.org/ebooks/1934), EPUB 2 noimages                                            | 2.0  | `fa4daa1ea820ef7fa073e0863c73fa3a889b0ac870e0df4ef5df2393fb4a4ae8` |       122507 |
| [The Adventures of Sherlock Holmes, Standard Ebooks](https://standardebooks.org/ebooks/arthur-conan-doyle/the-adventures-of-sherlock-holmes), EPUB 3 | 3.0  | `328a1cdb370d8f6d990ac1107b403c6fae8e5fc5ce80258aa785a4ba9ffb3e68` |       742054 |

Gutenberg's [terms of use](https://www.gutenberg.org/policy/terms_of_use.html) and each archive's license notice apply. Standard Ebooks explains its [public-domain scope](https://standardebooks.org/about/). U.S. public-domain statements do not establish permission in every country. The exact source/rights statements and retrieval dates are recorded in the local input manifest; the source notices remain in the tested archives. This change does not publish a sample library or determine rights for worldwide redistribution.

## Measured results

Counts are spine XHTML documents, not guaranteed one-file-per-chapter counts. "Styled" describes generated CSS coverage; it is not a claim that a reader judged the book more beautiful.

| Source          | Styled / total documents | Styled / total paragraphs | Original / output EPUBCheck 5.4.0 errors, warnings | Interpretation                                                                                                                 |
| --------------- | -----------------------: | ------------------------: | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Alice EPUB 3    |                   9 / 15 |                 635 / 778 | `1,0` / `1,0`                                      | Engine coverage proof only; pre-existing `RSC-005` in `toc.xhtml` remains and prevents publishing through the validation gate. |
| Alice EPUB 2    |                   9 / 14 |                 635 / 778 | `0,0` / `0,0`                                      | Initial ordinary-prose target, with five documents intentionally protected.                                                    |
| Walden EPUB 2   |                   5 / 26 |                  69 / 542 | `0,0` / `0,0`                                      | Partial coverage only; unknown classes, front matter and complex structures retain original styling.                           |
| Blake EPUB 2    |                   3 / 51 |                   7 / 210 | `0,0` / `0,0`                                      | Poetry protection comparison; only three simple documents admitted. Not full poetry support.                                   |
| Sherlock EPUB 3 |                No output |                 No output | `1,0` / not run                                    | Rejected for `UNSUPPORTED_RESOURCE` (`srcset`); source also has an independently recorded format error. No guard removed.      |

For the same exact Alice EPUB 3 source, the previous implementation styled `0/15` documents and `0/778` paragraphs. This before/after coverage measurement is distinct from visual acceptance. A separately downloaded 35 MiB Blake EPUB 3 exceeds the public beta's 20 MiB upload limit and is recorded as an input-boundary example, not a supported public upload.

The independent Python audit does not import application code. Across the five format cases, 1,776 checks verify source archive hashes, unchanged source files, all original XHTML body bytes, original resource bytes (including images, CSS and NCX), metadata, reading order and original manifest entries. It also checks each generated assignment's source range/hash, protected documents remaining byte-identical and declared English policy. The rejected Sherlock case only has source/checker evidence, not output integrity claims.

## Reproduction and remaining acceptance

The private notes workspace retains `outputs/overseas-readiness/corpus/manifest.json`, `outputs/overseas-readiness/backend/engine-matrix.json`, `independent-audit.json`, per-input/output EPUBCheck JSON, and the `work/overseas-readiness/backend/` runner/auditor. Re-download the official format, compare its SHA256 with the manifest, call `processEpub` with `typographyProfile: 'editorial-1'` into a new private output directory, run EPUBCheck 5.4.0 on both source and output, then compare the archives independently. Do not silently replace a changed upstream source under the old recorded hash.

New original regression fixtures reproduce the observed template shapes without copying book text. They cover language provenance/conflicts, nested chapter selectors/source hashes, reader controls, non-separator content, media/layout/unknown-class protection and an actual engine export. `npm run check` is required before submission; isolated database/Redis checks are CI responsibilities and do not run against existing user infrastructure.

The submitted implementation passes the complete local check, including 698 tests across 31 files. After the final admission fixes, all four generated outputs were rerun from the final compiled engine and matched the independently audited output SHA256 and per-document evidence exactly; Sherlock retained the same rejection code.

OS-04 remains open: import the actual files using Send to Kindle and USB separately, use identical reading settings, inspect headings, prose, special paragraphs, pagination, large text and dark mode, and record acceptance or regressions. Calibre conversion and a browser preview do not close that task. None of this change is deployed or merged by this PR.
