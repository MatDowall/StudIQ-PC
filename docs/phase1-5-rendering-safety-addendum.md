# Phase 1.5 Rendering Safety Addendum

## PDFium Process Boundary

PDFium must not run inside `desktop.exe`.

This applies to every PDF operation, including operations that appear lightweight:

- Opening a document.
- Reading page count.
- Reading page dimensions.
- Rendering previews.
- Rendering tiles.
- Adding a drawing to the drawing register.

All PDF metadata and rendering work must be delegated to `pdf_renderer.exe`.

## Metadata Loading

`pdf_renderer.exe` must provide a metadata command:

```text
pdf_renderer.exe meta <pdfium-dir> <pdf-path>
```

The command returns JSON equivalent to `DocumentMeta`:

```json
{
  "path": "C:\\path\\to\\drawing.pdf",
  "page_count": 1,
  "pages": [
    {
      "index": 0,
      "width_pts": 1190.55,
      "height_pts": 841.89
    }
  ]
}
```

`desktop.exe` may spawn `pdf_renderer.exe` and parse this JSON. It must not call PDFium APIs directly to produce the same metadata.

## Crash Class Prevented

This rule exists because testing confirmed `desktop.exe` can crash in `pdfium.dll` when a drawing is added and metadata is read in-process.

Observed Windows crash signature:

```text
Faulting application name: desktop.exe
Faulting module name: pdfium.dll
Exception code: 0x80000003
```

Any future feature that needs PDF metadata must reuse the out-of-process metadata command rather than introducing a new in-process PDFium call.
