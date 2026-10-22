'use client';

import React, { useState } from 'react';
import { 
  Users, 
  Search, 
  UserPlus, 
  Shield, 
  Coins, 
  CheckCircle2, 
  XCircle, 
  Clock, 
  MoreVertical, 
  Edit3, 
  Lock, 
  Unlock,
  Key,
  Trash2,
  TrendingUp,
  Eye,
  SlidersHorizontal,
  Building,
  CreditCard,
  Download
} from 'lucide-react';
import { 
  CustomerUser, 
  CustomerPlan, 
  CustomerUserStatus 
} from '@/types/admin';
import { UserProfileModal } from '@/components/admin/modals/user-profile-modal';

interface UsersManagementViewProps {
  users: CustomerUser[];
  onUpdateUser: (updatedUser: CustomerUser) => void;
  onAddUser: (newUser: Omit<CustomerUser, 'id'>) => void;
  onDeleteUser?: (userId: string) => void;
}

export const UsersManagementView: React.FC<UsersManagementViewProps> = ({
  users,
  onUpdateUser,
  onAddUser,
  onDeleteUser,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedPlan, setSelectedPlan] = useState<string>('ALL');
  const [selectedStatus, setSelectedStatus] = useState<string>('ALL');
  const [selectedUserForProfile, setSelectedUserForProfile] = useState<CustomerUser | null>(null);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [adjustCreditsUser, setAdjustCreditsUser] = useState<CustomerUser | null>(null);
  const [creditAdjustmentAmount, setCreditAdjustmentAmount] = useState<number>(500);

  // Invite user state
  const [inviteName, setInviteName] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteCompany, setInviteCompany] = useState('');
  const [invitePhone, setInvitePhone] = useState('');
  const [inviteRole, setInviteRole] = useState('Procurement Lead');
  const [invitePlan, setInvitePlan] = useState<CustomerPlan>('Professional');
  const [inviteCredits, setInviteCredits] = useState(500);

  const filteredUsers = users.filter(user => {
    const matchesSearch = 
      user.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      user.company.toLowerCase().includes(searchQuery.toLowerCase()) ||
      user.email.toLowerCase().includes(searchQuery.toLowerCase()) ||
      user.phone.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesPlan = selectedPlan === 'ALL' || user.plan === selectedPlan;
    const matchesStatus = selectedStatus === 'ALL' || user.status === selectedStatus;
    return matchesSearch && matchesPlan && matchesStatus;
  });

  const handleCreateUser = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteName.trim() || !inviteEmail.trim()) return;

    onAddUser({
      name: inviteName.trim(),
      company: inviteCompany.trim() || 'Enterprise Org',
      email: inviteEmail.trim(),
      phone: invitePhone.trim() || '+91 98000 00000',
      role: inviteRole,
      status: 'Active',
      plan: invitePlan,
      credits: inviteCredits,
      registeredDate: new Date().toISOString().split('T')[0],
      lastLogin: 'Never',
      totalSpent: 0,
      unlockedCount: 0,
      unlockedBusinesses: [],
      savedSearches: [],
      loginHistory: [],
      activityTimeline: [
        { id: `act-${Date.now()}`, action: 'Account Created', timestamp: 'Just now', details: 'Invited by Platform Administrator.' }
      ]
    });

    setInviteName('');
    setInviteEmail('');
    setInviteCompany('');
    setInvitePhone('');
    setShowInviteModal(false);
  };

  const handleApplyCreditAdjustment = () => {
    if (!adjustCreditsUser) return;
    const newBal = Math.max(0, adjustCreditsUser.credits + creditAdjustmentAmount);
    onUpdateUser({
      ...adjustCreditsUser,
      credits: newBal,
    });
    setAdjustCreditsUser(null);
  };

  const toggleUserStatus = (user: CustomerUser) => {
    const newStatus: CustomerUserStatus = user.status === 'Active' ? 'Suspended' : 'Active';
    onUpdateUser({
      ...user,
      status: newStatus,
    });
  };

  const handleAdjustCreditsModal = (user: CustomerUser, amount: number) => {
    const newBal = Math.max(0, user.credits + amount);
    onUpdateUser({
      ...user,
      credits: newBal,
    });
    if (selectedUserForProfile && selectedUserForProfile.id === user.id) {
      setSelectedUserForProfile({
        ...selectedUserForProfile,
        credits: newBal,
      });
    }
  };

  const handleUpgradePlanModal = (user: CustomerUser, newPlan: CustomerPlan) => {
    onUpdateUser({
      ...user,
      plan: newPlan,
    });
    if (selectedUserForProfile && selectedUserForProfile.id === user.id) {
      setSelectedUserForProfile({
        ...selectedUserForProfile,
        plan: newPlan,
      });
    }
  };

  const handleResetPasswordModal = (user: CustomerUser) => {
    alert(`Password reset link dispatched to ${user.email}`);
  };

  const handleDeleteUserModal = (userId: string) => {
    if (onDeleteUser) {
      onDeleteUser(userId);
    }
    setSelectedUserForProfile(null);
  };

  const handleExportCSV = () => {
    const headers = ['User ID', 'Name', 'Company', 'Email', 'Phone', 'Role', 'Credits', 'Status', 'Plan', 'Registered Date', 'Last Login'];
    const rows = filteredUsers.map(u => [
      u.id,
      `"${u.name}"`,
      `"${u.company}"`,
      u.email,
      u.phone,
      `"${u.role}"`,
      u.credits,
      u.status,
      u.plan,
      u.registeredDate,
      `"${u.lastLogin}"`
    ]);
    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `orion_customers_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="space-y-6">
      {/* Header Info */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-zinc-100 flex items-center gap-2">
            <Users className="w-5 h-5 text-zinc-300" />
            Customer & Account Management
          </h1>
          <p className="text-sm text-zinc-400 mt-1">
            Supervise Orion customer profiles, subscription tiers, wallet credit allocations, verified unlocks, and security authorizations.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleExportCSV}
            className="flex items-center gap-2 px-3.5 py-2 text-sm font-medium rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 transition"
          >
            <Download className="w-4 h-4" />
            Export CSV
          </button>
          <button
            onClick={() => setShowInviteModal(true)}
            className="flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg bg-zinc-100 hover:bg-white text-zinc-950 shadow transition self-start md:self-auto"
          >
            <UserPlus className="w-4 h-4" />
            Create Customer User
          </button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
          <div className="text-xs text-zinc-400 font-medium uppercase tracking-wider">Total Customers</div>
          <div className="text-2xl font-bold text-zinc-100 mt-1">{users.length}</div>
          <div className="text-xs text-zinc-400 mt-1">
            {users.filter(u => u.status === 'Active').length} Active subscriptions
          </div>
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
          <div className="text-xs text-zinc-400 font-medium uppercase tracking-wider">Enterprise Tiers</div>
          <div className="text-2xl font-bold text-zinc-100 mt-1">
            {users.filter(u => u.plan === 'Enterprise').length}
          </div>
          <div className="text-xs text-zinc-400 mt-1">
            High-volume SLA accounts
          </div>
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
          <div className="text-xs text-zinc-400 font-medium uppercase tracking-wider">Circulating Credits</div>
          <div className="text-2xl font-bold text-zinc-100 mt-1">
            {users.reduce((acc, u) => acc + u.credits, 0).toLocaleString()}
          </div>
          <div className="text-xs text-zinc-400 mt-1">
            In active customer wallets
          </div>
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
          <div className="text-xs text-zinc-400 font-medium uppercase tracking-wider">Total Unlocked Leads</div>
          <div className="text-2xl font-bold text-zinc-100 mt-1">
            {users.reduce((acc, u) => acc + u.unlockedCount, 0).toLocaleString()}
          </div>
          <div className="text-xs text-zinc-400 mt-1">
            Verified contact downloads
          </div>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 flex flex-col md:flex-row items-center justify-between gap-3">
        <div className="relative w-full md:w-80">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
          <input
            type="text"
            placeholder="Search by name, company, email, or phone..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg pl-9 pr-3 py-2 text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-zinc-500 transition"
          />
        </div>

        <div className="flex items-center gap-3 w-full md:w-auto">
          <select
            value={selectedPlan}
            onChange={e => setSelectedPlan(e.target.value)}
            className="bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-zinc-500"
          >
            <option value="ALL">All Plans</option>
            <option value="Starter">Starter</option>
            <option value="Professional">Professional</option>
            <option value="Growth">Growth</option>
            <option value="Enterprise">Enterprise</option>
          </select>

          <select
            value={selectedStatus}
            onChange={e => setSelectedStatus(e.target.value)}
            className="bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-zinc-500"
          >
            <option value="ALL">All Statuses</option>
            <option value="Active">Active</option>
            <option value="Inactive">Inactive</option>
            <option value="Suspended">Suspended</option>
            <option value="Pending Verification">Pending Verification</option>
          </select>
        </div>
      </div>

      {/* Customers Data Table */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm text-zinc-300">
            <thead className="bg-zinc-950 text-xs uppercase font-semibold text-zinc-400 border-b border-zinc-800">
              <tr>
                <th className="py-3.5 px-4 whitespace-nowrap align-middle">User Name & Company</th>
                <th className="py-3.5 px-4 whitespace-nowrap align-middle">Contact Details</th>
                <th className="py-3.5 px-4 whitespace-nowrap align-middle">Plan & Role</th>
                <th className="py-3.5 px-4 whitespace-nowrap align-middle">Status</th>
                <th className="py-3.5 px-4 text-right whitespace-nowrap align-middle">Credits</th>
                <th className="py-3.5 px-4 whitespace-nowrap align-middle">Registered / Last Login</th>
                <th className="py-3.5 px-4 text-right whitespace-nowrap align-middle">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60 font-mono text-xs">
              {filteredUsers.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-zinc-500 font-sans">
                    <Users className="w-8 h-8 mx-auto mb-2 text-zinc-600" />
                    No customers found matching the search criteria.
                  </td>
                </tr>
              ) : (
                filteredUsers.map(user => (
                  <tr key={user.id} className="hover:bg-zinc-800/40 transition">
                    <td className="py-3.5 px-4 font-sans align-middle">
                      <div className="font-semibold text-zinc-100 text-sm">{user.name}</div>
                      <div className="text-xs text-zinc-400 flex items-center gap-1 mt-0.5">
                        <Building className="w-3 h-3 text-zinc-500" />
                        {user.company}
                      </div>
                    </td>

                    <td className="py-3.5 px-4 font-mono text-xs text-zinc-300 align-middle whitespace-nowrap">
                      <div>{user.email}</div>
                      <div className="text-zinc-400 text-[11px] mt-0.5">{user.phone}</div>
                    </td>

                    <td className="py-3.5 px-4 font-sans align-middle whitespace-nowrap">
                      <div className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md text-xs font-semibold bg-zinc-800 text-zinc-200 border border-zinc-700">
                        {user.plan}
                      </div>
                      <div className="text-[11px] text-zinc-400 mt-1">{user.role}</div>
                    </td>

                    <td className="py-3.5 px-4 font-sans align-middle whitespace-nowrap">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold ${
                        user.status === 'Active' 
                          ? 'bg-zinc-800 text-zinc-100 border border-zinc-700' 
                          : user.status === 'Suspended'
                          ? 'bg-zinc-900 text-zinc-400 border border-zinc-700'
                          : 'bg-zinc-800/40 text-zinc-400 border border-zinc-800'
                      }`}>
                        {user.status === 'Active' ? <CheckCircle2 className="w-3 h-3 text-zinc-300" /> : <XCircle className="w-3 h-3 text-zinc-400" />}
                        {user.status}
                      </span>
                    </td>

                    <td className="py-3.5 px-4 text-right font-sans align-middle whitespace-nowrap tabular-nums">
                      <div className="font-bold text-zinc-100 text-sm">
                        {user.credits.toLocaleString()}
                      </div>
                      <div className="text-[10px] text-zinc-400">{user.unlockedCount} unlocked</div>
                    </td>

                    <td className="py-3.5 px-4 text-zinc-400 font-sans text-xs align-middle whitespace-nowrap">
                      <div>Reg: {user.registeredDate}</div>
                      <div className="text-[11px] text-zinc-500 mt-0.5 flex items-center gap-1 whitespace-nowrap">
                        <Clock className="w-3 h-3 shrink-0" /> {user.lastLogin}
                      </div>
                    </td>

                    <td className="py-3.5 px-4 text-right font-sans align-middle whitespace-nowrap">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          onClick={() => setSelectedUserForProfile(user)}
                          className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 transition flex items-center gap-1"
                          title="View complete user profile drawer"
                        >
                          <Eye className="w-3.5 h-3.5" /> View
                        </button>

                        <button
                          onClick={() => setAdjustCreditsUser(user)}
                          className="px-2.5 py-1 text-xs font-medium rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition"
                          title="Adjust credits"
                        >
                          Credits
                        </button>

                        <button
                          onClick={() => toggleUserStatus(user)}
                          className={`p-1.5 rounded-lg border transition ${
                            user.status === 'Active' 
                              ? 'bg-zinc-800 border-zinc-700 hover:bg-zinc-700 text-zinc-300' 
                              : 'bg-zinc-800 border-zinc-700 hover:bg-zinc-700 text-zinc-100'
                          }`}
                          title={user.status === 'Active' ? 'Suspend User Access' : 'Activate User Access'}
                        >
                          {user.status === 'Active' ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* User Profile Modal Drawer */}
      {selectedUserForProfile && (
        <UserProfileModal
          user={selectedUserForProfile}
          isOpen={!!selectedUserForProfile}
          onClose={() => setSelectedUserForProfile(null)}
          onUpdateUser={onUpdateUser}
          onDeleteUser={handleDeleteUserModal}
          onAdjustCredits={handleAdjustCreditsModal}
          onUpgradePlan={handleUpgradePlanModal}
          onResetPassword={handleResetPasswordModal}
        />
      )}

      {/* Invite Customer Modal */}
      {showInviteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 max-w-lg w-full shadow-2xl space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-zinc-800">
              <h3 className="text-base font-bold text-zinc-100 flex items-center gap-2">
                <UserPlus className="w-5 h-5 text-zinc-300" />
                Create Customer Account
              </h3>
              <button
                onClick={() => setShowInviteModal(false)}
                className="text-zinc-400 hover:text-zinc-200"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleCreateUser} className="space-y-3.5 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-zinc-400 mb-1">Customer Full Name</label>
                  <input
                    type="text"
                    required
                    value={inviteName}
                    onChange={e => setInviteName(e.target.value)}
                    placeholder="e.g. Ramesh Chandra"
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-zinc-500"
                  />
                </div>
                <div>
                  <label className="block font-medium text-zinc-400 mb-1">Company / Entity</label>
                  <input
                    type="text"
                    required
                    value={inviteCompany}
                    onChange={e => setInviteCompany(e.target.value)}
                    placeholder="e.g. Chandra Precision Tools"
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-zinc-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-zinc-400 mb-1">Corporate Email</label>
                  <input
                    type="email"
                    required
                    value={inviteEmail}
                    onChange={e => setInviteEmail(e.target.value)}
                    placeholder="e.g. ramesh@chandra.com"
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-zinc-500"
                  />
                </div>
                <div>
                  <label className="block font-medium text-zinc-400 mb-1">Phone Number (+91)</label>
                  <input
                    type="text"
                    value={invitePhone}
                    onChange={e => setInvitePhone(e.target.value)}
                    placeholder="e.g. +91 98400 12345"
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-zinc-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block font-medium text-zinc-400 mb-1">Subscription Plan</label>
                  <select
                    value={invitePlan}
                    onChange={e => setInvitePlan(e.target.value as any)}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-zinc-500"
                  >
                    <option value="Starter">Starter</option>
                    <option value="Professional">Professional</option>
                    <option value="Growth">Growth</option>
                    <option value="Enterprise">Enterprise</option>
                  </select>
                </div>

                <div>
                  <label className="block font-medium text-zinc-400 mb-1">Initial Credits</label>
                  <input
                    type="number"
                    value={inviteCredits}
                    onChange={e => setInviteCredits(Number(e.target.value))}
                    min={0}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-zinc-500"
                  />
                </div>

                <div>
                  <label className="block font-medium text-zinc-400 mb-1">Designation</label>
                  <input
                    type="text"
                    value={inviteRole}
                    onChange={e => setInviteRole(e.target.value)}
                    placeholder="e.g. VP Sales"
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-zinc-500"
                  />
                </div>
              </div>

              <div className="pt-3 border-t border-zinc-800 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowInviteModal(false)}
                  className="px-4 py-2 text-xs font-medium rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-xs font-bold rounded-lg bg-zinc-100 hover:bg-white text-zinc-950 transition"
                >
                  Create Customer
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Quick Adjust Credits Modal */}
      {adjustCreditsUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 max-w-sm w-full shadow-2xl space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-zinc-800">
              <h3 className="text-base font-bold text-zinc-100 flex items-center gap-2">
                <Coins className="w-5 h-5 text-zinc-300" />
                Adjust Customer Credits
              </h3>
              <button
                onClick={() => setAdjustCreditsUser(null)}
                className="text-zinc-400 hover:text-zinc-200"
              >
                ✕
              </button>
            </div>

            <div className="text-sm text-zinc-300">
              Adjusting wallet balance for <strong className="text-zinc-100">{adjustCreditsUser.name}</strong> ({adjustCreditsUser.company}).
            </div>

            <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-3 text-xs flex justify-between items-center">
              <span className="text-zinc-400">Current Balance:</span>
              <span className="font-bold text-zinc-200">{adjustCreditsUser.credits.toLocaleString()} Credits</span>
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1">
                Adjustment Amount (+ or -)
              </label>
              <input
                type="number"
                value={creditAdjustmentAmount}
                onChange={e => setCreditAdjustmentAmount(Number(e.target.value))}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-zinc-500"
              />
              <span className="text-[11px] text-zinc-400 mt-1 block">
                Use negative value to deduct credits (e.g. -200).
              </span>
            </div>

            <div className="pt-3 border-t border-zinc-800 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setAdjustCreditsUser(null)}
                className="px-3.5 py-2 text-xs font-medium rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleApplyCreditAdjustment}
                className="px-4 py-2 text-xs font-bold rounded-lg bg-zinc-100 hover:bg-white text-zinc-950 transition"
              >
                Apply Adjustment
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
