using System.Collections.Concurrent;

namespace PCMaintenance.Agent.Collectors;

public sealed class TaskbarApplicationStore
{
    private static readonly TimeSpan SnapshotLifetime = TimeSpan.FromSeconds(20);
    private readonly ConcurrentDictionary<int, Snapshot> _sessions = new();

    public void ReplaceSession(int sessionId, IEnumerable<int> processIds) =>
        _sessions[sessionId] = new Snapshot(processIds.Where(id => id > 0).Take(2500).ToHashSet(), DateTimeOffset.UtcNow);

    public bool Contains(int sessionId, int processId) =>
        _sessions.TryGetValue(sessionId, out var snapshot) &&
        DateTimeOffset.UtcNow - snapshot.ObservedAt <= SnapshotLifetime &&
        snapshot.ProcessIds.Contains(processId);

    public void RemoveSession(int sessionId) => _sessions.TryRemove(sessionId, out _);

    private sealed record Snapshot(HashSet<int> ProcessIds, DateTimeOffset ObservedAt);
}
