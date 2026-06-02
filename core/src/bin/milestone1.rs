use pdfium_render::prelude::*;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let pdf_path = args
        .get(1)
        .expect("Usage: milestone1 <path-to-pdf> <path-to-pdfium-dir>");
    let lib_path = args
        .get(2)
        .expect("Usage: milestone1 <path-to-pdf> <path-to-pdfium-dir>");

    println!("Loading pdfium from: {}", lib_path);

    let pdfium = Pdfium::new(
        Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path(lib_path))
            .expect("FAILED: Could not load pdfium library. Check the path and filename."),
    );

    println!("SUCCESS: pdfium loaded");

    let document = pdfium
        .load_pdf_from_file(pdf_path, None)
        .expect("FAILED: Could not open PDF. Check the file path.");

    let page_count = document.pages().len();
    println!("SUCCESS: PDF opened - {} pages", page_count);

    for i in 0..page_count.min(5) {
        let page = document.pages().get(i).unwrap();
        let (w, h) = (page.width().value, page.height().value);
        println!(
            "  Page {}: {:.1} x {:.1} pts  ({:.1} x {:.1} mm)",
            i,
            w,
            h,
            w * 0.352778,
            h * 0.352778
        );
    }

    println!("Milestone 1 PASSED");
}
