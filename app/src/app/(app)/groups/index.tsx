import { Link, router } from 'expo-router';
import { Pressable } from 'react-native';
import { useMyGroups } from '@/api/queries';
import { Body, Button, Card, Heading, Loading, QueryState, Row, Screen } from '@/components/ui';
import { useUserId } from '@/lib/auth';

export default function GroupsList() {
  const userId = useUserId();
  const groups = useMyGroups(userId);

  if (groups.isPending) return <Loading />;
  if (groups.isError) return <QueryState error={groups.error} onRetry={() => void groups.refetch()} />;

  return (
    <Screen refreshing={groups.isRefetching} onRefresh={() => void groups.refetch()}>
      {groups.data.length === 0 ? (
        <Card>
          <Heading>No groups yet</Heading>
          <Body muted>Start a group with 2 to 8 friends, or join one with an invite code.</Body>
        </Card>
      ) : (
        groups.data.map(({ group, memberCount, role }) => (
          <Link key={group.id} href={`/groups/${group.id}`} asChild>
            <Pressable accessibilityRole="button">
              <Card>
                <Heading>{group.name}</Heading>
                <Body muted>
                  {memberCount} {memberCount === 1 ? 'member' : 'members'}
                  {role === 'owner' ? ' · you started it' : ''}
                </Body>
              </Card>
            </Pressable>
          </Link>
        ))
      )}
      <Row>
        <Button title="Create a group" onPress={() => router.push('/groups/new?mode=create')} style={{ flex: 1 }} />
        <Button
          title="Join with code"
          variant="secondary"
          onPress={() => router.push('/groups/new?mode=join')}
          style={{ flex: 1 }}
        />
      </Row>
    </Screen>
  );
}
