using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using ExcelDna.Integration.CustomUI;

namespace StudIQ.ExcelAddin
{
    [ComVisible(true)]
    public class StudIQRibbon : ExcelRibbon
    {
        private const string RibbonXml = @"<customUI xmlns='http://schemas.microsoft.com/office/2009/07/customui'>
  <ribbon>
    <tabs>
      <tab id='studiqTab' label='StudIQ'>
        <group id='studiqGroup' label='StudIQ'>
          <button id='btnTaskPane' label='Dimensions Window' getImage='GetStudIQImage'
                  size='large' onAction='OnTaskPaneToggle'
                  screentip='Toggle the StudIQ Dimensions Window' />
        </group>
      </tab>
    </tabs>
  </ribbon>
</customUI>";

        public override string GetCustomUI(string ribbonId) => RibbonXml;

        public void OnTaskPaneToggle(IRibbonControl control) => StudIQAddin.ToggleTaskPane();

        public System.Drawing.Bitmap GetStudIQImage(IRibbonControl control)
        {
            var asm = Assembly.GetExecutingAssembly();
            using var stream = asm.GetManifestResourceStream("StudIQ.ExcelAddin.icon.png");
            if (stream == null) return null!;
            return new System.Drawing.Bitmap(stream);
        }
    }
}
