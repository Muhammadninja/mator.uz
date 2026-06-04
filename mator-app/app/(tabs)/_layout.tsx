// app/(tabs)/_layout.tsx — Tab layout with custom floating tab bar
import FloatingTabBar from '@/components/navigation/FloatingTabBar';
import { Tabs } from 'expo-router';

export default function TabLayout() {
  return (
    <Tabs
      tabBar={(props) => <FloatingTabBar {...props} />}
      screenOptions={{ headerShown: false }}
    >
      <Tabs.Screen name="index" options={{ title: 'home' }} />
      <Tabs.Screen name="chat" options={{ title: 'chat' }} />
      <Tabs.Screen name="garage" options={{ title: 'garage' }} />
      <Tabs.Screen name="orders" options={{ title: 'orders' }} />
      <Tabs.Screen name="profile" options={{ title: 'profile' }} />
    </Tabs>
  );
}
