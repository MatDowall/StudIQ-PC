using ExcelDna.Integration;
using ExcelDna.Integration.CustomUI;

namespace StudIQ.ExcelAddin
{
    public class StudIQAddin : IExcelAddIn
    {
        internal static ICustomTaskPane? TaskPane;

        public void AutoOpen() { }

        public void AutoClose()
        {
            TaskPane = null;
        }

        internal static void ToggleTaskPane()
        {
            if (TaskPane == null)
            {
                TaskPane = CustomTaskPaneFactory.CreateCustomTaskPane(
                    typeof(StudIQTaskPaneControl), "Dimensions Window");
                TaskPane.Width = 380;
                TaskPane.Visible = true;
            }
            else
            {
                TaskPane.Visible = !TaskPane.Visible;
            }
        }
    }
}
