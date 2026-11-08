import { Stack, router } from 'expo-router';
import { ActionSheetIOS, Platform } from 'react-native';
import { useMyGroups } from '@/api/queries';
import { EmptyState, ListGroup, ListRow, Screen, SkeletonList } from '@/components';
import { HeaderIconButton, HeaderItems } from '@/features/groups/headerButtons';
import { useUserId } from '@/lib/auth';
import { classifyRpcError, userMessage } from '@/lib/errors';

const members = (n: number) => `${n} ${n === 1 ? 'member' : 'members'}`;

function openAdd() {
  if (Platform.OS === 'ios') {
    ActionSheetIOS.showActionSheetWithOptions(
      { options: ['Create a group', 'Join with a code or link', 'Cancel'], cancelButtonIndex: 2 },
      (i) => {
        if (i === 0) router.push('/groups/new?mode=create');
        if (i === 1) router.push('/groups/new?mode=join');
      },
    );
    return;
  }
  router.push('/groups/new?mode=create');
}

export default function GroupsList() {
  const userId = useUserId();
  const groups = useMyGroups(userId);
  const data = groups.data;

  let content;
  if (groups.isPending) {
    content = <SkeletonList rows={3} />;
  } else if (!data) {
    const network = classifyRpcError(groups.error) === 'network';
    content = (
      <EmptyState
        layout="screen"
        icon={network ? 'wifi.slash' : 'exclamationmark.triangle'}
        title={network ? "You're offline" : "Couldn't load your groups"}
        body={network ? 'Your groups will appear once you have a connection. Nothing about today is lost.' : userMessage(groups.error)}
        action={{ label: 'Try again', onPress: () => void groups.refetch(), loading: groups.isFetching }}
      />
    );
  } else if (data.length === 0) {
    content = (
      <EmptyState
        layout="screen"
        icon="person.3"
        title="No groups yet"
        body="A group is 2 to 8 friends who keep each other honest. Start one, or join with the link a friend sent you."
        action={{ label: 'Start a group', onPress: () => router.push('/groups/new?mode=create') }}
        secondaryAction={{ label: 'Join with a code', onPress: () => router.push('/groups/new?mode=join') }}
      />
    );
  } else {
    content = (
      <ListGroup footer={groups.isError ? "Couldn't refresh. Showing what we had." : undefined}>
        {data.map(({ group, memberCount, role }) => (
          <ListRow
            key={group.id}
            title={group.name}
            subtitle={`${members(memberCount)}${role === 'owner' ? ' · you started it' : ''}`}
            chevron
            onPress={() => router.push(`/groups/${group.id}`)}
            accessibilityHint="Opens the group"
          />
        ))}
      </ListGroup>
    );
  }

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => (
            <HeaderItems>
              <HeaderIconButton icon="plus" label="New or join group" onPress={openAdd} testID="groups-add" />
              <HeaderIconButton icon="gearshape" label="Settings" onPress={() => router.push('/settings')} testID="groups-settings" />
            </HeaderItems>
          ),
        }}
      />
      <Screen refreshing={groups.isRefetching} onRefresh={() => void groups.refetch()}>
        {content}
      </Screen>
    </>
  );
}
