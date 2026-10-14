using System.Runtime.InteropServices;
using System.Text.Json;

namespace PCMaintenance.Agent.Collectors;

public static class TaskbarWindowMonitor
{
    private const int ExtendedStyleIndex = -20;
    private const int OwnerWindow = 4;
    private const long ToolWindowStyle = 0x00000080;
    private const long AppWindowStyle = 0x00040000;

    private static readonly HashSet<string> ShellWindowClasses = new(StringComparer.OrdinalIgnoreCase)
    {
        "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "Progman", "WorkerW",
    };

    public static async Task<int> RunAsync()
    {
        while (true)
        {
            try
            {
                var processIds = CollectVisibleApplicationProcessIds();
                await Console.Out.WriteLineAsync(JsonSerializer.Serialize(processIds));
                await Console.Out.FlushAsync();
            }
            catch (Exception exception)
            {
                await Console.Error.WriteLineAsync($"Taskbar window scan failed: {exception.Message}");
            }

            await Task.Delay(TimeSpan.FromSeconds(5));
        }
    }

    public static IReadOnlyCollection<int> CollectVisibleApplicationProcessIds()
    {
        var processIds = new HashSet<int>();
        EnumWindows((window, _) =>
        {
            if (!IsWindowVisible(window)) return true;
            var extendedStyle = GetExtendedWindowStyle(window).ToInt64();
            var isAppWindow = (extendedStyle & AppWindowStyle) != 0;
            var isToolWindow = (extendedStyle & ToolWindowStyle) != 0;
            if (!isAppWindow && (isToolWindow || GetWindow(window, OwnerWindow) != IntPtr.Zero)) return true;

            var className = new System.Text.StringBuilder(128);
            if (GetClassName(window, className, className.Capacity) > 0 && ShellWindowClasses.Contains(className.ToString())) return true;
            GetWindowThreadProcessId(window, out var processId);
            if (processId is > 0 and <= int.MaxValue) processIds.Add((int)processId);
            return true;
        }, IntPtr.Zero);
        return processIds;
    }

    private static IntPtr GetExtendedWindowStyle(IntPtr window) => IntPtr.Size == 8
        ? GetWindowLongPtr64(window, ExtendedStyleIndex)
        : new IntPtr(GetWindowLong32(window, ExtendedStyleIndex));

    private delegate bool EnumWindowsCallback(IntPtr window, IntPtr parameter);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr parameter);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll")]
    private static extern IntPtr GetWindow(IntPtr window, int command);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetClassNameW", SetLastError = true)]
    private static extern int GetClassName(IntPtr window, System.Text.StringBuilder className, int maximumCount);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW", SetLastError = true)]
    private static extern IntPtr GetWindowLongPtr64(IntPtr window, int index);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongW", SetLastError = true)]
    private static extern int GetWindowLong32(IntPtr window, int index);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
}
