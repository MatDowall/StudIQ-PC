use image::{ImageBuffer, Rgba};
use pdfium_render::prelude::*;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let pdf_path = args
        .get(1)
        .expect("Usage: milestone2 <pdf-path> <pdfium-dir>");
    let lib_path = args
        .get(2)
        .expect("Usage: milestone2 <pdf-path> <pdfium-dir>");

    let pdfium = Pdfium::new(
        Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path(lib_path))
            .expect("Could not load pdfium"),
    );

    let document = pdfium
        .load_pdf_from_file(pdf_path, None)
        .expect("Could not open PDF");

    let page = document.pages().get(0).expect("No pages");

    let render_config = PdfRenderConfig::new()
        .set_target_width(512)
        .set_target_height(512);

    println!("Rendering tile...");
    let bitmap = page
        .render_with_config(&render_config)
        .expect("Render failed");

    let rgba_bytes = bitmap.as_rgba_bytes();
    println!("Rendered {} bytes of RGBA data", rgba_bytes.len());

    let img: ImageBuffer<Rgba<u8>, Vec<u8>> = ImageBuffer::from_raw(
        bitmap.width() as u32,
        bitmap.height() as u32,
        rgba_bytes.to_vec(),
    )
    .expect("Failed to create image buffer");

    img.save("milestone2_tile.png").expect("Failed to save PNG");

    println!("SUCCESS: Tile saved to milestone2_tile.png");
    println!("Open this file now and confirm it shows a portion of the PDF.");
    println!("Milestone 2 PASSED");
}
