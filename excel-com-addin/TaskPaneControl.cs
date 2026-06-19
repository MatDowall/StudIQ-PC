using System;
using System.Drawing;
using System.IO;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Forms;
using ExcelDna.Integration;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Newtonsoft.Json.Linq;

namespace StudIQ.ExcelAddin
{
    [ComVisible(true)]
    [Guid("F1E2D3C4-B5A6-7890-ABCD-EF1234567890")]
    public class StudIQTaskPaneControl : UserControl
    {
        private const string TaskpaneUrl = "https://localhost:3998/taskpane.html";
        private const int BridgePort = 3998;

        private const string ErrorHtml = @"<!DOCTYPE html>
<html>
<head><meta charset='UTF-8'/></head>
<body style='margin:0;display:flex;align-items:center;justify-content:center;height:100vh;
             font-family:Segoe UI,sans-serif;background:#1e1e2e;color:#cdd6f4;'>
  <p style='font-size:13px;text-align:center;line-height:1.6;opacity:0.75;'>
    StudIQ instance not open,<br>open a project to view dimensions
  </p>
</body>
</html>";

        private readonly WebView2 _web;
        private System.Windows.Forms.Timer? _pollTimer;
        private bool _handlingError = false;

        // Drag-to-insert arm state
        private string? _armedFormula = null;
        private string? _armInitialAddress = null;
        private bool _armInitialized = false;
        private System.Windows.Forms.Timer? _armTimer;
        // Set while the pointer is dragging outside the task pane. Suppresses
        // arm polling so hover-driven cell selection changes don't trigger an
        // early insert.
        private volatile bool _isHovering = false;

        public StudIQTaskPaneControl()
        {
            _web = new WebView2 { Dock = DockStyle.Fill };
            Controls.Add(_web);
            Load += OnLoad;
        }

        private async void OnLoad(object? sender, EventArgs e)
        {
            try
            {
                var userDataPath = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "StudIQ", "WebView2");
                Directory.CreateDirectory(userDataPath);
                var env = await CoreWebView2Environment.CreateAsync(null, userDataPath);
                await _web.EnsureCoreWebView2Async(env);
                _web.CoreWebView2.WebMessageReceived += OnWebMessage;
                // Inject flag before every page load so JS can detect ExcelDNA context
                // even when WebView2 serves a cached page.
                await _web.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(
                    "window.__studiqHost = true;");
                _web.CoreWebView2.NavigationCompleted += OnNavigationCompleted;
                var ts = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
                _web.Source = new Uri($"{TaskpaneUrl}?v={ts}");
            }
            catch (Exception ex)
            {
                Controls.Remove(_web);
                Controls.Add(new Label
                {
                    Text = $"StudIQ task pane could not load.\n\n{ex.Message}\n\nMake sure the WebView2 Runtime is installed and StudIQ is running.",
                    Dock = DockStyle.Fill,
                    TextAlign = ContentAlignment.MiddleCenter,
                    Padding = new Padding(12),
                    ForeColor = Color.DarkRed,
                });
            }
        }

        private void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            if (_handlingError)
            {
                // This completion is from our own NavigateToString — ignore it.
                _handlingError = false;
                return;
            }

            if (!e.IsSuccess)
            {
                _handlingError = true;
                _web.CoreWebView2.NavigateToString(ErrorHtml);
                StartPolling();
            }
            else
            {
                StopPolling();
            }
        }

        private void StartPolling()
        {
            if (_pollTimer != null) return;
            _pollTimer = new System.Windows.Forms.Timer { Interval = 3000 };
            _pollTimer.Tick += async (s, e) =>
            {
                if (await IsBridgeAvailable())
                {
                    StopPolling();
                    _web.Source = new Uri(TaskpaneUrl);
                }
            };
            _pollTimer.Start();
        }

        private void StopPolling()
        {
            _pollTimer?.Stop();
            _pollTimer?.Dispose();
            _pollTimer = null;
        }

        private static async Task<bool> IsBridgeAvailable()
        {
            try
            {
                using var tcp = new TcpClient();
                var connect = tcp.ConnectAsync("127.0.0.1", BridgePort);
                return await Task.WhenAny(connect, Task.Delay(1000)) == connect && tcp.Connected;
            }
            catch { return false; }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                StopPolling();
                StopArmPolling();
            }
            base.Dispose(disposing);
        }

        private void StartArmPolling(string formula)
        {
            StopArmPolling();
            _armedFormula = formula;
            _armInitialized = false;
            _armInitialAddress = null;

            // Capture the baseline address on Excel's thread NOW — before any
            // cell change can happen — then start the polling timer.
            // Previously the baseline was captured on the first timer tick, but
            // a fast drag could change the active cell before that tick fired,
            // causing the formula to never insert.
            ExcelAsyncUtil.QueueAsMacro(() =>
            {
                try
                {
                    dynamic app = ExcelDnaUtil.Application;
                    string? addr = app.ActiveCell?.Address as string;
                    _armInitialAddress = addr;
                    _armInitialized = (addr != null);
                }
                catch { }

                this.BeginInvoke(new Action(() =>
                {
                    if (_armedFormula == null) return; // disarmed while we were getting baseline
                    _armTimer = new System.Windows.Forms.Timer { Interval = 150 };
                    _armTimer.Tick += OnArmPollTick;
                    _armTimer.Start();
                }));
            });
        }

        private void StopArmPolling()
        {
            _armTimer?.Stop();
            _armTimer?.Dispose();
            _armTimer = null;
            _armedFormula = null;
            _armInitialAddress = null;
            _armInitialized = false;
            _isHovering = false;
        }

        private void OnArmPollTick(object? sender, EventArgs e)
        {
            ExcelAsyncUtil.QueueAsMacro(() =>
            {
                try
                {
                    dynamic app = ExcelDnaUtil.Application;
                    string? addr = app.ActiveCell?.Address as string;
                    if (addr == null) return;

                    // Fallback: if baseline wasn't captured (QueueAsMacro race), set it now.
                    if (!_armInitialized)
                    {
                        _armInitialAddress = addr;
                        _armInitialized = true;
                        return;
                    }

                    // While the pointer is dragging over Excel, hover-driven
                    // selection changes would otherwise trigger a premature insert.
                    // Keep the baseline current so the first real post-drop click
                    // still works if RangeFromPoint ever fails.
                    if (_isHovering)
                    {
                        _armInitialAddress = addr;
                        return;
                    }

                    if (addr != _armInitialAddress)
                    {
                        var formula = _armedFormula;
                        StopArmPolling();
                        if (formula != null)
                            app.ActiveCell.Formula = formula;

                        this.BeginInvoke(new Action(() =>
                        {
                            _web.CoreWebView2?.PostWebMessageAsString("{\"type\":\"formulaInserted\"}");
                        }));
                    }
                }
                catch { /* Excel not accessible during arm poll */ }
            });
        }

        // Called when JS reports pointerup outside the task pane viewport.
        // Uses RangeFromPoint to identify and write to the cell under the cursor
        // directly, without requiring the user to click the cell again.
        // Falls back to arm polling if the point is not over an Excel cell.
        private void TryInsertAtPoint(int screenX, int screenY, string formula)
        {
            ExcelAsyncUtil.QueueAsMacro(() =>
            {
                try
                {
                    dynamic app = ExcelDnaUtil.Application;
                    // RangeFromPoint takes screen-space pixel coordinates and
                    // returns the cell at that position, or throws if none.
                    dynamic range = app.ActiveWindow.RangeFromPoint(screenX, screenY);
                    range.Select();
                    app.ActiveCell.Formula = formula;
                }
                catch
                {
                    // Point not over an Excel cell — leave arm polling running
                    // so the user can click the target cell to insert.
                    return;
                }

                this.BeginInvoke(new Action(() =>
                {
                    StopArmPolling();
                    _web.CoreWebView2?.PostWebMessageAsString("{\"type\":\"formulaInserted\"}");
                }));
            });
        }

        private void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            try
            {
                var msg = JObject.Parse(e.WebMessageAsJson);
                var type = msg["type"]?.ToString();

                if (type == "insertFormula")
                {
                    var formula = msg["formula"]?.ToString();
                    if (!string.IsNullOrEmpty(formula))
                    {
                        var captured = formula;
                        ExcelAsyncUtil.QueueAsMacro(() =>
                        {
                            dynamic app = ExcelDnaUtil.Application;
                            app.ActiveCell.Formula = captured;
                        });
                    }
                }
                else if (type == "refreshAll")
                {
                    ExcelAsyncUtil.QueueAsMacro(() =>
                    {
                        dynamic app = ExcelDnaUtil.Application;
                        app.Calculate();
                    });
                }
                else if (type == "armFormula")
                {
                    var formula = msg["formula"]?.ToString();
                    if (!string.IsNullOrEmpty(formula))
                    {
                        string captured = formula!;
                        this.BeginInvoke(new Action(() => StartArmPolling(captured)));
                    }
                }
                else if (type == "hoverCell")
                {
                    _isHovering = true;
                    int screenX = (int)(msg["screenX"]?.Value<double>() ?? 0);
                    int screenY = (int)(msg["screenY"]?.Value<double>() ?? 0);
                    ExcelAsyncUtil.QueueAsMacro(() =>
                    {
                        try
                        {
                            dynamic app = ExcelDnaUtil.Application;
                            dynamic range = app.ActiveWindow.RangeFromPoint(screenX, screenY);
                            // Update baseline so polling doesn't fire on hover selection.
                            _armInitialAddress = range.Address as string;
                            range.Select();
                        }
                        catch { /* cursor not over a cell */ }
                    });
                }
                else if (type == "pointerReleased")
                {
                    _isHovering = false;
                    int screenX = (int)(msg["screenX"]?.Value<double>() ?? 0);
                    int screenY = (int)(msg["screenY"]?.Value<double>() ?? 0);
                    var formula = msg["formula"]?.ToString() ?? _armedFormula;
                    if (!string.IsNullOrEmpty(formula))
                    {
                        string capturedFormula = formula!;
                        this.BeginInvoke(new Action(() => TryInsertAtPoint(screenX, screenY, capturedFormula)));
                    }
                }
                else if (type == "disarmFormula")
                {
                    this.BeginInvoke(new Action(() => StopArmPolling()));
                }
            }
            catch { /* malformed message — ignore */ }
        }
    }
}
